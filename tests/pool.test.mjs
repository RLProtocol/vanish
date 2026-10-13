// End-to-end tests against the deployed program on a local validator.
// Run with `anchor test` (starts solana-test-validator with the program loaded).
import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import { ComputeBudgetProgram, Connection, Keypair as SolKeypair, LAMPORTS_PER_SOL, PublicKey, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, createMint, getOrCreateAssociatedTokenAccount, mintTo, getAccount } from "@solana/spl-token";
import { Keypair, Utxo, assetId } from "../sdk/crypto.js";
import { SolMixClient, addAssetInstruction, initializeInstruction, pdas, prepareTransaction, setAssetInstruction, toRaw, transactInstruction } from "../sdk/solmix.js";
import { NATIVE_SOL } from "../sdk/assets.js";
import { proveNode } from "../sdk/prove-node.js";

const PROGRAM_ID = new PublicKey("92DHWjMnbgcBdEmQ3hWoiJthFbP6Bk5e513pZAsQqoUG");
const url = process.env.ANCHOR_PROVIDER_URL ?? "http://127.0.0.1:8899";
const walletPath = (process.env.ANCHOR_WALLET ?? "~/.config/solana/id.json").replace("~", os.homedir());
const connection = new Connection(url, "confirmed");
const admin = SolKeypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(walletPath, "utf8"))));
const P = pdas(PROGRAM_ID);

const walletOf = (kp) => ({ publicKey: kp.publicKey, signTransaction: async (tx) => (tx.sign([kp]), tx) });
// same compute budget the SDK requests: a withdrawal needs ~200k CU, right at the default limit
const send = (ixs, signers) =>
  sendAndConfirmTransaction(connection, new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), ...ixs), signers, { commitment: "confirmed" });
const memStore = () => { const m = new Map(); return { get: (k) => m.get(k), set: (k, v) => m.set(k, v) }; };
const client = (kp = new Keypair()) => new SolMixClient({ connection, programId: PROGRAM_ID, keypair: kp, prove: proveNode, storage: memStore() });
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

const SOL = { symbol: "SOL", mint: NATIVE_SOL, decimals: 9, tokenProgram: null, denominations: ["0.1", "1", "5", "20"] };
let STOCK; // Token-2022, 8 decimals (like xStocks)
let DOLLAR; // classic SPL Token, 6 decimals (like USDC)
let alice;

before(async () => {
  await send([initializeInstruction({ programId: PROGRAM_ID, admin: admin.publicKey })], [admin]);
  await send([addAssetInstruction({ programId: PROGRAM_ID, admin: admin.publicKey, asset: SOL })], [admin]);

  alice = await funded();
  const stockMint = await createMint(connection, admin, admin.publicKey, null, 8, undefined, undefined, TOKEN_2022_PROGRAM_ID);
  const dollarMint = await createMint(connection, admin, admin.publicKey, null, 6, undefined, undefined, TOKEN_PROGRAM_ID);
  STOCK = { symbol: "TSTx", mint: stockMint.toBase58(), decimals: 8, tokenProgram: TOKEN_2022_PROGRAM_ID.toBase58(), denominations: ["0.1", "1", "10", "50"] };
  DOLLAR = { symbol: "TUSD", mint: dollarMint.toBase58(), decimals: 6, tokenProgram: TOKEN_PROGRAM_ID.toBase58(), denominations: ["10", "100", "500", "1000"] };
  for (const a of [STOCK, DOLLAR]) {
    await send([addAssetInstruction({ programId: PROGRAM_ID, admin: admin.publicKey, asset: a })], [admin]);
    const ata = await getOrCreateAssociatedTokenAccount(connection, alice, new PublicKey(a.mint), alice.publicKey, false, "confirmed", undefined, new PublicKey(a.tokenProgram));
    await mintTo(connection, admin, new PublicKey(a.mint), ata.address, admin, toRaw("100000", a.decimals), [], undefined, new PublicKey(a.tokenProgram));
  }
});

test("SOL: shield a fixed size, unshield a custom amount, keep private change", async () => {
  const c = client();
  await c.shield({ asset: SOL, amount: toRaw("1", 9), wallet: walletOf(alice) });
  assert.equal((await c.getUnspent(SOL)).reduce((s, u) => s + u.amount, 0n), toRaw("1", 9));

  const bob = SolKeypair.generate().publicKey;
  await c.unshield({ asset: SOL, amount: toRaw("0.337", 9), to: bob, wallet: walletOf(alice) });
  assert.equal(BigInt(await connection.getBalance(bob)), toRaw("0.337", 9));
  const left = (await c.getUnspent(SOL)).reduce((s, u) => s + u.amount, 0n);
  assert.equal(left, toRaw("0.663", 9));
});

test("Token-2022 stock: shield 10 shares, unshield 3.5 to a fresh wallet (ATA created on the fly)", async () => {
  const c = client();
  await c.shield({ asset: STOCK, amount: toRaw("10", 8), wallet: walletOf(alice) });
  const bob = SolKeypair.generate().publicKey;
  await c.unshield({ asset: STOCK, amount: toRaw("3.5", 8), to: bob, wallet: walletOf(alice) });
  const acct = await getAccount(connection, c.receivingAccount(STOCK, bob), "confirmed", TOKEN_2022_PROGRAM_ID);
  assert.equal(acct.amount, toRaw("3.5", 8));
  assert.equal((await c.getUnspent(STOCK)).reduce((s, u) => s + u.amount, 0n), toRaw("6.5", 8));
});

test("classic SPL dollar: two notes merged privately when a withdrawal needs three", async () => {
  const c = client();
  for (let i = 0; i < 3; i++) await c.shield({ asset: DOLLAR, amount: toRaw("10", 6), wallet: walletOf(alice) });
  const stages = [];
  await c.unshield({ asset: DOLLAR, amount: toRaw("25", 6), to: SolKeypair.generate().publicKey, wallet: walletOf(alice), onStage: (s) => stages.push(s) });
  assert.ok(stages.includes("merge"), "a merge happened");
  assert.equal((await c.getUnspent(DOLLAR)).reduce((s, u) => s + u.amount, 0n), toRaw("5", 6));
});

test("rejects deposits that aren't a listed size, even with a valid proof", async () => {
  const c = client();
  await c.sync();
  const id = assetId(new PublicKey(SOL.mint));
  const args = await prepareTransaction({
    tree: c.tree, asset: SOL, outputs: [new Utxo({ amount: toRaw("0.2", 9), assetId: id, keypair: c.keypair })],
    extAmount: toRaw("0.2", 9), recipient: alice.publicKey, relayer: alice.publicKey, keypair: c.keypair, prove: proveNode,
  });
  const ix = transactInstruction({ programId: PROGRAM_ID, signer: alice.publicKey, asset: SOL, recipient: alice.publicKey, relayer: alice.publicKey, args });
  await rejects(send([ix], [alice]), /InvalidDenomination|not an allowed deposit size/);
});

test("rejects double spends", async () => {
  const c = client();
  await c.shield({ asset: SOL, amount: toRaw("0.1", 9), wallet: walletOf(alice) });
  const [note] = await c.getUnspent(SOL);
  const mk = () => prepareTransaction({ tree: c.tree, asset: SOL, inputs: [note], extAmount: -toRaw("0.1", 9), recipient: alice.publicKey, relayer: alice.publicKey, keypair: c.keypair, prove: proveNode });
  const ix = async () => transactInstruction({ programId: PROGRAM_ID, signer: alice.publicKey, asset: SOL, recipient: alice.publicKey, relayer: alice.publicKey, args: await mk() });
  await send([await ix()], [alice]);
  await rejects(send([await ix()], [alice]), /already in use/);
});

test("a proof can't be redirected to another recipient (front-running)", async () => {
  const c = client();
  await c.shield({ asset: SOL, amount: toRaw("0.1", 9), wallet: walletOf(alice) });
  const [note] = await c.getUnspent(SOL);
  const bob = SolKeypair.generate().publicKey;
  const args = await prepareTransaction({ tree: c.tree, asset: SOL, inputs: [note], extAmount: -toRaw("0.1", 9), recipient: bob, relayer: bob, keypair: c.keypair, prove: proveNode });
  const thief = await funded(1);
  const ix = transactInstruction({ programId: PROGRAM_ID, signer: thief.publicKey, asset: SOL, recipient: thief.publicKey, relayer: bob, args });
  await rejects(send([ix], [thief]), /InvalidProof|does not verify/);
});

test("a stock note can't be withdrawn as a different asset", async () => {
  const c = client();
  await c.shield({ asset: STOCK, amount: toRaw("1", 8), wallet: walletOf(alice) });
  const [note] = await c.getUnspent(STOCK);
  // same proof, but pointed at the dollar asset's accounts
  const args = await prepareTransaction({ tree: c.tree, asset: STOCK, inputs: [note], extAmount: -toRaw("1", 8), recipient: alice.publicKey, relayer: alice.publicKey, keypair: c.keypair, prove: proveNode });
  const dollarAta = c.receivingAccount(DOLLAR, alice.publicKey);
  const ix = transactInstruction({ programId: PROGRAM_ID, signer: alice.publicKey, asset: DOLLAR, recipient: dollarAta, relayer: dollarAta, args });
  await rejects(send([ix], [alice]), /InvalidProof|does not verify/);
});

test("withdrawals keep working while deposits are paused", async () => {
  const c = client();
  await c.shield({ asset: SOL, amount: toRaw("0.1", 9), wallet: walletOf(alice) });
  await send([setAssetInstruction({ programId: PROGRAM_ID, admin: admin.publicKey, mint: SOL.mint, paused: true })], [admin]);
  await rejects(c.shield({ asset: SOL, amount: toRaw("0.1", 9), wallet: walletOf(alice) }), /DepositsPaused|paused/);
  await c.unshield({ asset: SOL, amount: toRaw("0.1", 9), to: SolKeypair.generate().publicKey, wallet: walletOf(alice) });
  await send([setAssetInstruction({ programId: PROGRAM_ID, admin: admin.publicKey, mint: SOL.mint, paused: false })], [admin]);
});

test("pool vaults hold exactly what the notes say", async () => {
  const vault = await getAccount(connection, P.vault(STOCK), "confirmed", TOKEN_2022_PROGRAM_ID);
  // 10 + 1 shielded, 3.5 withdrawn in earlier tests
  assert.equal(vault.amount, toRaw("7.5", 8));
});

test("anonymity(): counts other people's deposits of the same asset after yours", async () => {
  const me = client();
  await me.shield({ asset: SOL, amount: toRaw("0.1", 9), wallet: walletOf(alice) });
  let a = await me.anonymity(SOL);
  assert.equal(a.after, 0, "nobody deposited after me yet");

  const others = await funded(5);
  for (let i = 0; i < 3; i++) await client().shield({ asset: SOL, amount: toRaw("0.1", 9), wallet: walletOf(others) });
  await client().shield({ asset: STOCK, amount: toRaw("1", 8), wallet: walletOf(alice) }); // different asset: not counted
  a = await me.anonymity(SOL);
  assert.equal(a.after, 3);
  assert.ok(a.total >= 4);

  await me.shield({ asset: SOL, amount: toRaw("0.1", 9), wallet: walletOf(alice) }); // my newest deposit resets the count
  assert.equal((await me.anonymity(SOL)).after, 0);
});
