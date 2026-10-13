// v2 shielded swaps, end to end on a local validator with the mock aggregator.
// Needs solmix built with `--features mock-swap` (SO=target/mock/solmix.so) and mock_swap loaded;
// skipped otherwise.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import {
  AddressLookupTableProgram, ComputeBudgetProgram, Connection, Keypair as SolKeypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram,
  TransactionMessage, VersionedTransaction,
} from "@solana/web3.js";
import {
  NATIVE_MINT, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction, createMint, createSyncNativeInstruction, getAccount, getAssociatedTokenAddressSync,
  getOrCreateAssociatedTokenAccount, mintTo,
} from "@solana/spl-token";
import { sha256 } from "@noble/hashes/sha256";
import { Keypair, Utxo, assetId } from "../sdk/crypto.js";
import { NATIVE_SOL } from "../sdk/assets.js";
import { SolMixClient, Writer, addAssetInstruction, initializeInstruction, pdas, prepareTransaction, toRaw } from "../sdk/solmix.js";
import {
  decodeOrder, escrowAddress, escrowMint, escrowTokenProgram, prepareSwap, swapCancelInstruction, swapCommitOutInstruction,
  swapExecuteInstruction, swapOpenInstruction, swapPrepareInstruction,
} from "../sdk/swap.js";
import { buyCancelInstruction, buyEscrowAddress, buyExecuteInstruction, buyOpenInstruction, decodeBuyOrder, destinationTokenAccount, orderTokenAccount, prepareBuy } from "../sdk/buy.js";
import { proveNode } from "../sdk/prove-node.js";

const PROGRAM_ID = new PublicKey("92DHWjMnbgcBdEmQ3hWoiJthFbP6Bk5e513pZAsQqoUG");
const MOCK_ID = new PublicKey("9rX8mRUjYP6yugEcM9DtzZriTDaRheNQuPHQeSk4f1uB");
const url = process.env.ANCHOR_PROVIDER_URL ?? "http://127.0.0.1:8899";
const walletPath = (process.env.ANCHOR_WALLET ?? "~/.config/solana/id.json").replace("~", os.homedir());
const connection = new Connection(url, "confirmed");
const admin = SolKeypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(walletPath, "utf8"))));
const P = pdas(PROGRAM_ID);
const [RESERVE] = PublicKey.findProgramAddressSync([Buffer.from("reserve")], MOCK_ID);
const mockDisc = (n) => sha256(new TextEncoder().encode(`global:${n}`)).subarray(0, 8);

const SOL = { symbol: "SOL", mint: NATIVE_SOL, decimals: 9, tokenProgram: null, denominations: ["0.1", "1", "5", "20"] };
let STOCK; // Token-2022, 8 decimals
let DOLLAR; // classic SPL, 6 decimals
let MEME; // unlisted Token-2022 token, like a pump.fun coin: only ever bought, never held by the pool
let alice, relayer, lut;
const enabled = !!(await connection.getAccountInfo(MOCK_ID).catch(() => null));

const walletOf = (kp) => ({ publicKey: kp.publicKey, signTransaction: async (tx) => (tx.sign([kp]), tx) });
const memStore = () => { const m = new Map(); return { get: (k) => m.get(k), set: (k, v) => m.set(k, v) }; };
const client = (kp = new Keypair()) => new SolMixClient({ connection, programId: PROGRAM_ID, keypair: kp, prove: proveNode, storage: memStore() });

async function send(ixs, signers, units = 400_000) {
  const { blockhash } = await connection.getLatestBlockhash("confirmed");
  const msg = new TransactionMessage({
    payerKey: signers[0].publicKey, recentBlockhash: blockhash,
    instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units }), ...ixs],
  }).compileToV0Message(lut ? [lut] : []);
  const tx = new VersionedTransaction(msg);
  tx.sign(signers);
  const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false });
  const res = await connection.confirmTransaction(sig, "confirmed");
  if (res.value.err) throw new Error(`failed: ${JSON.stringify(res.value.err)}`);
  return sig;
}
async function funded(sol = 50) {
  const kp = SolKeypair.generate();
  await connection.confirmTransaction(await connection.requestAirdrop(kp.publicKey, sol * LAMPORTS_PER_SOL), "confirmed");
  return kp;
}
const rejects = async (p, re) => {
  try {
    await p;
  } catch (e) {
    const text = [e.message, ...(e.logs ?? []), ...(e.transactionLogs ?? [])].join("\n");
    assert.match(text, re);
    return;
  }
  assert.fail("expected the transaction to fail");
};
const sum = (us) => us.reduce((s, u) => s + u.amount, 0n);
const tokenBal = async (addr, program) => (await getAccount(connection, addr, "confirmed", program)).amount;
const reserveAccount = (asset) => getAssociatedTokenAddressSync(escrowMint(asset), RESERVE, true, escrowTokenProgram(asset));

/** Mock route: the order sells exactly amountIn and receives exactly amountOut. */
function mockRoute({ order, assetIn, assetOut, amountIn, amountOut }) {
  const k = (pubkey, isWritable = false) => ({ pubkey, isWritable });
  return {
    programId: MOCK_ID,
    keys: [
      k(order), k(escrowAddress(order, assetIn), true), k(escrowAddress(order, assetOut), true), k(RESERVE),
      k(reserveAccount(assetIn), true), k(reserveAccount(assetOut), true), k(escrowMint(assetIn)), k(escrowMint(assetOut)),
      k(escrowTokenProgram(assetIn)), k(escrowTokenProgram(assetOut)),
    ],
    data: new Writer().bytes(mockDisc("swap")).u64(amountIn).u64(amountOut).done(),
  };
}

/** Runs prepare -> commit_out -> open with the relayer signing; returns everything a test needs. */
async function openSwap({ c, assetIn, assetOut, amountIn, minOut, fee = 0n, deadlineIn = 600 }) {
  await c.sync();
  const inputs = (await c.getUnspent(assetIn)).slice(0, 2);
  const relayerFeeAccount = assetIn.mint === NATIVE_SOL ? relayer.publicKey : getAssociatedTokenAddressSync(new PublicKey(assetIn.mint), relayer.publicKey, false, new PublicKey(assetIn.tokenProgram));
  const now = (await connection.getBlockTime(await connection.getSlot("confirmed"))) ?? Math.floor(Date.now() / 1000);
  const sw = await prepareSwap({
    programId: PROGRAM_ID, tree: c.tree, keypair: c.keypair, prove: proveNode, assetIn, assetOut,
    inputs: inputs.map((n) => c._utxo(n)), amountIn, minOut, fee, relayerFeeAccount, deadline: now + deadlineIn,
  });
  await send([swapPrepareInstruction({ programId: PROGRAM_ID, relayer: relayer.publicKey, assetIn, orderId: sw.orderId, deadline: sw.deadline, refund: sw.refund })], [relayer]);
  await send([swapCommitOutInstruction({ programId: PROGRAM_ID, relayer: relayer.publicKey, assetOut, order: sw.order, out: sw.out })], [relayer]);
  await send([swapOpenInstruction({ programId: PROGRAM_ID, relayer: relayer.publicKey, relayerFeeAccount, assetIn, order: sw.order, open: sw.open })], [relayer]);
  return sw;
}
const execute = ({ sw, assetIn, assetOut, amountIn, amountOut, route, relayerOutAccount }) =>
  send([swapExecuteInstruction({
    programId: PROGRAM_ID, relayer: relayer.publicKey, assetIn, assetOut, order: sw.order,
    relayerOutAccount: relayerOutAccount ?? (assetOut.mint === NATIVE_SOL ? relayer.publicKey : getAssociatedTokenAddressSync(new PublicKey(assetOut.mint), relayer.publicKey, false, new PublicKey(assetOut.tokenProgram))),
    route: route ?? mockRoute({ order: sw.order, assetIn, assetOut, amountIn, amountOut }),
  })], [relayer], 600_000);
const orderState = async (order) => decodeOrder((await connection.getAccountInfo(order, "confirmed")).data);

before(async () => {
  if (!enabled) return;
  if (!(await connection.getAccountInfo(P.pool))) await send([initializeInstruction({ programId: PROGRAM_ID, admin: admin.publicKey })], [admin]);
  if (!(await connection.getAccountInfo(P.asset(NATIVE_SOL)))) await send([addAssetInstruction({ programId: PROGRAM_ID, admin: admin.publicKey, asset: SOL })], [admin]);

  alice = await funded();
  relayer = await funded();
  const stockMint = await createMint(connection, admin, admin.publicKey, null, 8, undefined, undefined, TOKEN_2022_PROGRAM_ID);
  const dollarMint = await createMint(connection, admin, admin.publicKey, null, 6, undefined, undefined, TOKEN_PROGRAM_ID);
  STOCK = { symbol: "SWSTK", mint: stockMint.toBase58(), decimals: 8, tokenProgram: TOKEN_2022_PROGRAM_ID.toBase58(), denominations: ["0.1", "1", "10", "50"] };
  DOLLAR = { symbol: "SWUSD", mint: dollarMint.toBase58(), decimals: 6, tokenProgram: TOKEN_PROGRAM_ID.toBase58(), denominations: ["10", "100", "500", "1000"] };
  for (const a of [STOCK, DOLLAR]) {
    const mint = new PublicKey(a.mint);
    const tp = new PublicKey(a.tokenProgram);
    await send([addAssetInstruction({ programId: PROGRAM_ID, admin: admin.publicKey, asset: a })], [admin]);
    for (const owner of [alice.publicKey, relayer.publicKey]) {
      const ata = await getOrCreateAssociatedTokenAccount(connection, admin, mint, owner, false, "confirmed", undefined, tp);
      if (owner.equals(alice.publicKey)) await mintTo(connection, admin, mint, ata.address, admin, toRaw("100000", a.decimals), [], undefined, tp);
    }
    // mock aggregator liquidity
    const reserve = await getOrCreateAssociatedTokenAccount(connection, admin, mint, RESERVE, true, "confirmed", undefined, tp);
    await mintTo(connection, admin, mint, reserve.address, admin, toRaw("1000000", a.decimals), [], undefined, tp);
  }
  const memeMint = await createMint(connection, admin, admin.publicKey, null, 6, undefined, undefined, TOKEN_2022_PROGRAM_ID);
  MEME = { symbol: "MEME", mint: memeMint.toBase58(), decimals: 6, tokenProgram: TOKEN_2022_PROGRAM_ID.toBase58() };
  const memeReserve = await getOrCreateAssociatedTokenAccount(connection, admin, memeMint, RESERVE, true, "confirmed", undefined, TOKEN_2022_PROGRAM_ID);
  await mintTo(connection, admin, memeMint, memeReserve.address, admin, toRaw("1000000000", 6), [], undefined, TOKEN_2022_PROGRAM_ID);
  const wsol = await getOrCreateAssociatedTokenAccount(connection, admin, NATIVE_MINT, RESERVE, true, "confirmed");
  await send([SystemProgram.transfer({ fromPubkey: admin.publicKey, toPubkey: wsol.address, lamports: 100 * LAMPORTS_PER_SOL }), createSyncNativeInstruction(wsol.address)], [admin]);

  // lookup table so the proof-carrying transactions fit in 1232 bytes
  const slot = await connection.getSlot("confirmed");
  const [createIx, lutAddress] = AddressLookupTableProgram.createLookupTable({ authority: admin.publicKey, payer: admin.publicKey, recentSlot: slot - 1 });
  const addresses = [
    PROGRAM_ID, P.pool, P.solVault, P.asset(NATIVE_SOL), SystemProgram.programId, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, NATIVE_MINT,
    new PublicKey("ATokenGPvbdGVxr1b2hvZbsqBW5M5WQxTXVcpR7wqFsy"), ComputeBudgetProgram.programId, MOCK_ID, RESERVE,
    ...[STOCK, DOLLAR].flatMap((a) => [new PublicKey(a.mint), P.asset(a.mint), P.vault(a), reserveAccount(a)]), reserveAccount(SOL),
    new PublicKey(MEME.mint), reserveAccount(MEME),
  ];
  await send([createIx, AddressLookupTableProgram.extendLookupTable({ lookupTable: lutAddress, authority: admin.publicKey, payer: admin.publicKey, addresses })], [admin]);
  for (let i = 0; i < 30; i++) {
    const res = await connection.getAddressLookupTable(lutAddress, { commitment: "confirmed" });
    if (res.value && (await connection.getSlot("confirmed")) > slot + 1) { lut = res.value; break; }
    await new Promise((r) => setTimeout(r, 400));
  }
  assert.ok(lut, "lookup table never became active");
});

test("swap SOL -> Token-2022 stock: notes appear, surplus tips the relayer, fee paid in SOL", { skip: !enabled }, async () => {
  const c = client();
  await c.shield({ asset: SOL, amount: toRaw("1", 9), wallet: walletOf(alice) });
  const vaultSolBefore = BigInt(await connection.getBalance(P.solVault));
  const stockVaultBefore = await tokenBal(P.vault(STOCK), TOKEN_2022_PROGRAM_ID);
  const relayerStock = getAssociatedTokenAddressSync(new PublicKey(STOCK.mint), relayer.publicKey, false, TOKEN_2022_PROGRAM_ID);

  const amountIn = toRaw("0.5", 9), minOut = toRaw("2", 8), fee = toRaw("0.003", 9);
  const sw = await openSwap({ c, assetIn: SOL, assetOut: STOCK, amountIn, minOut, fee });
  await execute({ sw, assetIn: SOL, assetOut: STOCK, amountIn, amountOut: toRaw("2.1", 8) });

  await c.sync();
  assert.equal(sum(await c.getUnspent(SOL)), toRaw("1", 9) - amountIn - fee);
  assert.equal(sum(await c.getUnspent(STOCK)), minOut);
  assert.equal(BigInt(await connection.getBalance(P.solVault)), vaultSolBefore - amountIn - fee);
  assert.equal(await tokenBal(P.vault(STOCK), TOKEN_2022_PROGRAM_ID), stockVaultBefore + minOut);
  assert.equal(await tokenBal(relayerStock, TOKEN_2022_PROGRAM_ID), toRaw("0.1", 8));
  assert.equal(await connection.getAccountInfo(sw.order), null, "order closed");
  assert.equal(await connection.getAccountInfo(escrowAddress(sw.order, SOL)), null, "escrows closed");

  // the swapped stock is spendable like any other note
  const bob = SolKeypair.generate().publicKey;
  await c.unshield({ asset: STOCK, amount: toRaw("1.5", 8), to: bob, wallet: walletOf(alice) });
  assert.equal(sum(await c.getUnspent(STOCK)), toRaw("0.5", 8));
});

test("swap classic SPL dollars -> SOL: output unwraps into the SOL vault, partial fill returns to the pool", { skip: !enabled }, async () => {
  const c = client();
  await c.shield({ asset: DOLLAR, amount: toRaw("100", 6), wallet: walletOf(alice) });
  const vaultSolBefore = BigInt(await connection.getBalance(P.solVault));
  const dollarVaultBefore = await tokenBal(P.vault(DOLLAR), TOKEN_PROGRAM_ID);

  const amountIn = toRaw("100", 6), minOut = toRaw("0.4", 9);
  const sw = await openSwap({ c, assetIn: DOLLAR, assetOut: SOL, amountIn, minOut });
  // the route only spends 90 of the 100: the other 10 must go back to the pool vault
  await execute({ sw, assetIn: DOLLAR, assetOut: SOL, amountIn, amountOut: minOut, route: mockRoute({ order: sw.order, assetIn: DOLLAR, assetOut: SOL, amountIn: toRaw("90", 6), amountOut: minOut }) });

  await c.sync();
  assert.equal(sum(await c.getUnspent(SOL)), minOut);
  assert.equal(sum(await c.getUnspent(DOLLAR)), 0n);
  assert.equal(BigInt(await connection.getBalance(P.solVault)), vaultSolBefore + minOut);
  assert.equal(await tokenBal(P.vault(DOLLAR), TOKEN_PROGRAM_ID), dollarVaultBefore - toRaw("90", 6));

  const bob = SolKeypair.generate().publicKey;
  await c.unshield({ asset: SOL, amount: toRaw("0.25", 9), to: bob, wallet: walletOf(alice) });
  assert.equal(BigInt(await connection.getBalance(bob)), toRaw("0.25", 9));
});

test("route that returns less than min_out reverts; relayer cancel refunds a private note", { skip: !enabled }, async () => {
  const c = client();
  await c.shield({ asset: STOCK, amount: toRaw("10", 8), wallet: walletOf(alice) });
  const stockVaultBefore = await tokenBal(P.vault(STOCK), TOKEN_2022_PROGRAM_ID);
  const amountIn = toRaw("4", 8), minOut = toRaw("1", 9), fee = toRaw("0.002", 8);
  const sw = await openSwap({ c, assetIn: STOCK, assetOut: SOL, amountIn, minOut, fee });
  assert.equal(await tokenBal(P.vault(STOCK), TOKEN_2022_PROGRAM_ID), stockVaultBefore - amountIn - fee);

  await rejects(execute({ sw, assetIn: STOCK, assetOut: SOL, amountIn, amountOut: minOut - 1n }), /SwapUnderfilled|returned less/);

  const state = await orderState(sw.order);
  assert.ok(state.opened && state.outReady);
  await send([swapCancelInstruction({ programId: PROGRAM_ID, caller: relayer.publicKey, order: sw.order, state, assetIn: STOCK, assetOut: SOL })], [relayer]);
  await c.sync();
  assert.equal(sum(await c.getUnspent(STOCK)), toRaw("10", 8) - fee, "change + refund = everything but the fee");
  assert.equal(sum(await c.getUnspent(SOL)), 0n, "output notes never credited");
  assert.equal(await tokenBal(P.vault(STOCK), TOKEN_2022_PROGRAM_ID), stockVaultBefore - fee);
  assert.equal(await connection.getAccountInfo(sw.order), null);
});

test("routes cannot touch pool accounts or spend anything but the escrow", { skip: !enabled }, async () => {
  const c = client();
  await c.shield({ asset: DOLLAR, amount: toRaw("10", 6), wallet: walletOf(alice) });
  const amountIn = toRaw("10", 6), minOut = toRaw("0.1", 8);
  const sw = await openSwap({ c, assetIn: DOLLAR, assetOut: STOCK, amountIn, minOut });

  // the pool PDA in the route is refused outright
  const withPool = mockRoute({ order: sw.order, assetIn: DOLLAR, assetOut: STOCK, amountIn, amountOut: minOut });
  withPool.keys.push({ pubkey: P.pool, isWritable: false });
  await rejects(execute({ sw, assetIn: DOLLAR, assetOut: STOCK, route: withPool }), /ForbiddenRouteAccount|may not touch/);

  // the order's signature can't move the pool vault's tokens
  const thief = getAssociatedTokenAddressSync(new PublicKey(DOLLAR.mint), relayer.publicKey);
  const steal = {
    programId: MOCK_ID,
    keys: [
      { pubkey: sw.order, isWritable: false }, { pubkey: P.vault(DOLLAR), isWritable: true }, { pubkey: thief, isWritable: true },
      { pubkey: new PublicKey(DOLLAR.mint), isWritable: false }, { pubkey: TOKEN_PROGRAM_ID, isWritable: false },
    ],
    data: new Writer().bytes(mockDisc("steal")).u64(toRaw("10", 6)).done(),
  };
  await rejects(execute({ sw, assetIn: DOLLAR, assetOut: STOCK, route: steal }), /owner does not match|0x4|custom program error/);

  // only the whitelisted aggregator can be called
  const ix = swapExecuteInstruction({
    programId: PROGRAM_ID, relayer: relayer.publicKey, assetIn: DOLLAR, assetOut: STOCK, order: sw.order, relayerOutAccount: relayer.publicKey,
    route: { programId: TOKEN_PROGRAM_ID, keys: [], data: new Uint8Array() },
  });
  await rejects(send([ix], [relayer]), /WrongSwapProgram|whitelisted/);

  // the honest route still works afterwards
  await execute({ sw, assetIn: DOLLAR, assetOut: STOCK, amountIn, amountOut: minOut });
  await c.sync();
  assert.equal(sum(await c.getUnspent(STOCK)), minOut);
});

test("relayer cannot substitute its own output notes", { skip: !enabled }, async () => {
  const c = client();
  await c.shield({ asset: SOL, amount: toRaw("1", 9), wallet: walletOf(alice) });
  await c.sync();
  const inputs = (await c.getUnspent(SOL)).map((n) => c._utxo(n));
  const now = Math.floor(Date.now() / 1000);
  const common = { programId: PROGRAM_ID, tree: c.tree, prove: proveNode, assetIn: SOL, assetOut: STOCK, amountIn: toRaw("1", 9), minOut: toRaw("1", 8), relayerFeeAccount: relayer.publicKey, deadline: now + 600 };
  const honest = await prepareSwap({ ...common, keypair: c.keypair, inputs });
  // the relayer proves output notes worth min_out for its own key, on the same order
  const thiefKey = new Keypair();
  const evilOut = await prepareTransaction({
    tree: c.tree, asset: STOCK, outputs: [new Utxo({ amount: toRaw("1", 8), assetId: assetId(new PublicKey(STOCK.mint)), keypair: thiefKey })],
    extAmount: toRaw("1", 8), recipient: honest.order, relayer: honest.order, keypair: thiefKey, prove: proveNode,
  });

  await send([swapPrepareInstruction({ programId: PROGRAM_ID, relayer: relayer.publicKey, assetIn: SOL, orderId: honest.orderId, deadline: honest.deadline, refund: honest.refund })], [relayer]);
  await send([swapCommitOutInstruction({ programId: PROGRAM_ID, relayer: relayer.publicKey, assetOut: STOCK, order: honest.order, out: evilOut })], [relayer]);
  await rejects(
    send([swapOpenInstruction({ programId: PROGRAM_ID, relayer: relayer.publicKey, relayerFeeAccount: relayer.publicKey, assetIn: SOL, order: honest.order, open: honest.open })], [relayer]),
    /InvalidProof|does not verify/,
  );
  // nothing was spent: the user's note is still there
  await c.sync();
  assert.equal(sum(await c.getUnspent(SOL)), toRaw("1", 9));
});

test("after the deadline anyone can cancel; before it only the relayer", { skip: !enabled }, async () => {
  const c = client();
  await c.shield({ asset: SOL, amount: toRaw("1", 9), wallet: walletOf(alice) });
  const sw = await openSwap({ c, assetIn: SOL, assetOut: STOCK, amountIn: toRaw("1", 9), minOut: toRaw("3", 8), deadlineIn: 20 });
  const stranger = await funded(1);
  let state = await orderState(sw.order);
  const cancel = () => send([swapCancelInstruction({ programId: PROGRAM_ID, caller: stranger.publicKey, order: sw.order, state, assetIn: SOL, assetOut: STOCK })], [stranger]);
  await rejects(cancel(), /Unauthorized|Only the pool admin/);

  for (let i = 0; i < 80; i++) {
    const t = await connection.getBlockTime(await connection.getSlot("confirmed"));
    if (t > Number(state.deadline)) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  await rejects(execute({ sw, assetIn: SOL, assetOut: STOCK, amountIn: toRaw("1", 9), amountOut: toRaw("3", 8) }), /SwapExpired|deadline/);
  const vaultBefore = BigInt(await connection.getBalance(P.solVault));
  state = await orderState(sw.order);
  await cancel();
  await c.sync();
  assert.equal(sum(await c.getUnspent(SOL)), toRaw("1", 9));
  assert.equal(BigInt(await connection.getBalance(P.solVault)), vaultBefore + toRaw("1", 9));
});

// ---------------------------------------------------------------------------- private buy

/** Mock route delivering straight to the destination's token account. */
function mockBuyRoute({ order, assetIn, destination, amountIn, amountOut, toOrder = false }) {
  const k = (pubkey, isWritable = false) => ({ pubkey, isWritable });
  const out = toOrder ? orderTokenAccount(order, MEME.mint, MEME.tokenProgram) : destinationTokenAccount(destination, MEME.mint, MEME.tokenProgram);
  return {
    programId: MOCK_ID,
    keys: [
      k(order), k(buyEscrowAddress(order, assetIn), true), k(out, true), k(RESERVE),
      k(reserveAccount(assetIn), true), k(reserveAccount(MEME), true), k(escrowMint(assetIn)), k(new PublicKey(MEME.mint)),
      k(escrowTokenProgram(assetIn)), k(TOKEN_2022_PROGRAM_ID),
    ],
    data: new Writer().bytes(mockDisc("swap")).u64(amountIn).u64(amountOut).done(),
  };
}

async function openBuy({ c, assetIn, amountIn, minOut, gas = 0n, fee = 0n, destination, deadlineIn = 600 }) {
  await c.sync();
  const inputs = (await c.getUnspent(assetIn)).slice(0, 2).map((n) => c._utxo(n));
  const relayerFeeAccount = assetIn.mint === NATIVE_SOL ? relayer.publicKey : getAssociatedTokenAddressSync(new PublicKey(assetIn.mint), relayer.publicKey, false, new PublicKey(assetIn.tokenProgram));
  const now = (await connection.getBlockTime(await connection.getSlot("confirmed"))) ?? Math.floor(Date.now() / 1000);
  const b = await prepareBuy({
    programId: PROGRAM_ID, tree: c.tree, keypair: c.keypair, prove: proveNode, assetIn, inputs, amountIn, gas, fee, relayerFeeAccount,
    mintOut: MEME.mint, minOut, deadline: now + deadlineIn, destination,
  });
  await send([buyOpenInstruction({ programId: PROGRAM_ID, relayer: relayer.publicKey, relayerFeeAccount, assetIn, orderId: b.orderId, terms: b.terms, open: b.open })], [relayer]);
  return b;
}
const executeBuy = ({ b, assetIn, destination, amountIn, amountOut, route }) =>
  send([
    createAssociatedTokenAccountIdempotentInstruction(relayer.publicKey, destinationTokenAccount(destination, MEME.mint, MEME.tokenProgram), destination, new PublicKey(MEME.mint), TOKEN_2022_PROGRAM_ID),
    createAssociatedTokenAccountIdempotentInstruction(relayer.publicKey, orderTokenAccount(b.order, MEME.mint, MEME.tokenProgram), b.order, new PublicKey(MEME.mint), TOKEN_2022_PROGRAM_ID),
    buyExecuteInstruction({
      programId: PROGRAM_ID, relayer: relayer.publicKey, assetIn, order: b.order, destination, mintOut: MEME.mint, tokenProgramOut: MEME.tokenProgram, withOrderTokenOut: true,
      route: route ?? mockBuyRoute({ order: b.order, assetIn, destination, amountIn, amountOut }),
    }),
  ], [relayer], 600_000);
const memeBal = (owner) => tokenBal(destinationTokenAccount(owner, MEME.mint, MEME.tokenProgram), TOKEN_2022_PROGRAM_ID);

test("private buy with SOL: unlisted token + gas land in a brand-new wallet, unspent SOL returns to the pool", { skip: !enabled }, async () => {
  const c = client();
  await c.shield({ asset: SOL, amount: toRaw("5", 9), wallet: walletOf(alice) });
  const fresh = SolKeypair.generate().publicKey;
  const vaultBefore = BigInt(await connection.getBalance(P.solVault));
  const amountIn = toRaw("2", 9), gas = toRaw("0.01", 9), fee = toRaw("0.006", 9), minOut = toRaw("4800000", 6);

  const b = await openBuy({ c, assetIn: SOL, amountIn, gas, fee, minOut, destination: fresh });
  // the route only needs 1.9 SOL and over-delivers: the user keeps the extra tokens
  await executeBuy({ b, assetIn: SOL, destination: fresh, route: mockBuyRoute({ order: b.order, assetIn: SOL, destination: fresh, amountIn: toRaw("1.9", 9), amountOut: toRaw("4870000", 6) }) });

  assert.equal(await memeBal(fresh), toRaw("4870000", 6));
  assert.equal(BigInt(await connection.getBalance(fresh)), gas, "gas arrived");
  assert.equal(BigInt(await connection.getBalance(P.solVault)), vaultBefore - toRaw("1.9", 9) - gas - fee);
  await c.sync();
  assert.equal(sum(await c.getUnspent(SOL)), toRaw("5", 9) - amountIn - gas - fee);
  assert.equal(await connection.getAccountInfo(b.order), null, "order closed");

  // no transaction touching the new wallet mentions alice's wallet
  for (const { signature } of await connection.getSignaturesForAddress(fresh, {}, "confirmed")) {
    const tx = await connection.getTransaction(signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
    const keys = tx.transaction.message.getAccountKeys({ addressLookupTableAccounts: [lut] });
    for (let i = 0; i < keys.length; i++) assert.ok(!keys.get(i).equals(alice.publicKey));
  }
});

test("private buy with a listed token (dollars) as input; output parked on the order is swept to the new wallet", { skip: !enabled }, async () => {
  const c = client();
  await c.shield({ asset: DOLLAR, amount: toRaw("100", 6), wallet: walletOf(alice) });
  const fresh = SolKeypair.generate().publicKey;
  const b = await openBuy({ c, assetIn: DOLLAR, amountIn: toRaw("60", 6), fee: toRaw("0.5", 6), minOut: toRaw("1000", 6), destination: fresh });
  // this route parks the output in the order's own account: it must still reach the new wallet
  await executeBuy({ b, assetIn: DOLLAR, destination: fresh, route: mockBuyRoute({ order: b.order, assetIn: DOLLAR, destination: fresh, amountIn: toRaw("60", 6), amountOut: toRaw("1000", 6), toOrder: true }) });
  assert.equal(await memeBal(fresh), toRaw("1000", 6));
  assert.equal(await connection.getAccountInfo(orderTokenAccount(b.order, MEME.mint, MEME.tokenProgram)), null, "parking account closed");
  await c.sync();
  assert.equal(sum(await c.getUnspent(DOLLAR)), toRaw("39.5", 6));
});

test("private buy: underfilled route reverts; cancel pays the SOL (and gas) to the new wallet", { skip: !enabled }, async () => {
  const c = client();
  await c.shield({ asset: SOL, amount: toRaw("1", 9), wallet: walletOf(alice) });
  const fresh = SolKeypair.generate().publicKey;
  const amountIn = toRaw("0.5", 9), gas = toRaw("0.002", 9), minOut = toRaw("1000", 6);
  const b = await openBuy({ c, assetIn: SOL, amountIn, gas, minOut, destination: fresh });
  await rejects(executeBuy({ b, assetIn: SOL, destination: fresh, amountIn, amountOut: minOut - 1n }), /SwapUnderfilled|returned less/);

  const state = decodeBuyOrder((await connection.getAccountInfo(b.order, "confirmed")).data);
  await send([buyCancelInstruction({ programId: PROGRAM_ID, caller: relayer.publicKey, order: b.order, state, assetIn: SOL })], [relayer]);
  assert.equal(BigInt(await connection.getBalance(fresh)), amountIn + gas);
  assert.equal(await connection.getAccountInfo(b.order), null);
});

test("private buy: relayer can't redirect the tokens or change the terms", { skip: !enabled }, async () => {
  const c = client();
  await c.shield({ asset: SOL, amount: toRaw("1", 9), wallet: walletOf(alice) });
  await c.sync();
  const fresh = SolKeypair.generate().publicKey;
  const thief = SolKeypair.generate().publicKey;
  const inputs = (await c.getUnspent(SOL)).map((n) => c._utxo(n));
  const now = Math.floor(Date.now() / 1000);
  const b = await prepareBuy({
    programId: PROGRAM_ID, tree: c.tree, keypair: c.keypair, prove: proveNode, assetIn: SOL, inputs, amountIn: toRaw("0.5", 9),
    relayerFeeAccount: relayer.publicKey, mintOut: MEME.mint, minOut: toRaw("1000", 6), deadline: now + 600, destination: fresh,
  });
  const open = (terms) => send([buyOpenInstruction({ programId: PROGRAM_ID, relayer: relayer.publicKey, relayerFeeAccount: relayer.publicKey, assetIn: SOL, orderId: b.orderId, terms, open: b.open })], [relayer]);
  // a lower min_out or another destination breaks the proof
  await rejects(open({ ...b.terms, minOut: 1n }), /InvalidProof|does not verify/);
  await rejects(open({ ...b.terms, destination: thief.toBase58() }), /InvalidProof|does not verify/);
  await open(b.terms);
  // delivering to another wallet is refused
  await rejects(executeBuy({ b, assetIn: SOL, destination: thief, amountIn: toRaw("0.5", 9), amountOut: toRaw("1000", 6) }), /WrongVault|ConstraintHasOne|has one/i);
  // and so is touching the pool from the route
  const bad = mockBuyRoute({ order: b.order, assetIn: SOL, destination: fresh, amountIn: toRaw("0.5", 9), amountOut: toRaw("1000", 6) });
  bad.keys.push({ pubkey: P.solVault, isWritable: true });
  await rejects(executeBuy({ b, assetIn: SOL, destination: fresh, route: bad }), /ForbiddenRouteAccount|may not touch/);
  await executeBuy({ b, assetIn: SOL, destination: fresh, amountIn: toRaw("0.5", 9), amountOut: toRaw("1000", 6) });
  assert.equal(await memeBal(fresh), toRaw("1000", 6));
});

test("private buy: anyone can cancel after the deadline, only the relayer before", { skip: !enabled }, async () => {
  const c = client();
  await c.shield({ asset: SOL, amount: toRaw("1", 9), wallet: walletOf(alice) });
  const fresh = SolKeypair.generate().publicKey;
  const b = await openBuy({ c, assetIn: SOL, amountIn: toRaw("0.3", 9), minOut: toRaw("1", 6), destination: fresh, deadlineIn: 12 });
  const stranger = await funded(1);
  const state = decodeBuyOrder((await connection.getAccountInfo(b.order, "confirmed")).data);
  const cancel = () => send([buyCancelInstruction({ programId: PROGRAM_ID, caller: stranger.publicKey, order: b.order, state, assetIn: SOL })], [stranger]);
  await rejects(cancel(), /Unauthorized|Only the pool admin/);
  for (let i = 0; i < 80; i++) {
    if ((await connection.getBlockTime(await connection.getSlot("confirmed"))) > Number(state.deadline)) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  await rejects(executeBuy({ b, assetIn: SOL, destination: fresh, amountIn: toRaw("0.3", 9), amountOut: toRaw("1", 6) }), /SwapExpired|deadline/);
  await cancel();
  assert.equal(BigInt(await connection.getBalance(fresh)), toRaw("0.3", 9));
});
