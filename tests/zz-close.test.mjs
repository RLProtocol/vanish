// Admin cleanup guards: assets close only when paused long enough and empty; the pool only
// when every asset is closed. Runs last (the other suites leave funds in the pool).
// The close delay is 5 s in test builds (`--features mock-swap`); skipped otherwise.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import { ComputeBudgetProgram, Connection, Keypair as SolKeypair, LAMPORTS_PER_SOL, PublicKey, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, createMint, getOrCreateAssociatedTokenAccount, mintTo } from "@solana/spl-token";
import { Keypair } from "../sdk/crypto.js";
import { NATIVE_SOL } from "../sdk/assets.js";
import { SolMixClient, addAssetInstruction, closeAssetInstruction, closePoolInstruction, initializeInstruction, pdas, setAssetInstruction, toRaw } from "../sdk/solmix.js";
import { proveNode } from "../sdk/prove-node.js";

const PROGRAM_ID = new PublicKey("92DHWjMnbgcBdEmQ3hWoiJthFbP6Bk5e513pZAsQqoUG");
const MOCK_ID = new PublicKey("9rX8mRUjYP6yugEcM9DtzZriTDaRheNQuPHQeSk4f1uB");
const connection = new Connection(process.env.ANCHOR_PROVIDER_URL ?? "http://127.0.0.1:8899", "confirmed");
const admin = SolKeypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync((process.env.ANCHOR_WALLET ?? "~/.config/solana/id.json").replace("~", os.homedir()), "utf8"))));
const P = pdas(PROGRAM_ID);
const enabled = !!(await connection.getAccountInfo(MOCK_ID).catch(() => null));
const SOL = { symbol: "SOL", mint: NATIVE_SOL, decimals: 9, tokenProgram: null, denominations: ["0.1", "1", "5", "20"] };

const send = (ixs, signers = [admin]) =>
  sendAndConfirmTransaction(connection, new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), ...ixs), signers, { commitment: "confirmed" });
const rejects = async (p, re) => {
  try {
    await p;
  } catch (e) {
    assert.match([e.message, ...(e.logs ?? []), ...(e.transactionLogs ?? [])].join("\n"), re);
    return;
  }
  assert.fail("expected the transaction to fail");
};
const pause = (asset, paused = true) => send([setAssetInstruction({ programId: PROGRAM_ID, admin: admin.publicKey, mint: asset.mint, paused })]);
const close = (asset) => send([closeAssetInstruction({ programId: PROGRAM_ID, admin: admin.publicKey, asset })]);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const assetCount = async () => (await connection.getAccountInfo(P.pool)).data.readBigUInt64LE(8 + 32 + 8 + 8 + 32 * 20 * 2 + 32 * 100);

let EMPTY, FUNDED;
before(async () => {
  if (!enabled) return;
  if (!(await connection.getAccountInfo(P.pool))) await send([initializeInstruction({ programId: PROGRAM_ID, admin: admin.publicKey })]);
  if (!(await connection.getAccountInfo(P.asset(NATIVE_SOL)))) await send([addAssetInstruction({ programId: PROGRAM_ID, admin: admin.publicKey, asset: SOL })]);
  const mk = async (symbol) => {
    const mint = await createMint(connection, admin, admin.publicKey, null, 6, undefined, undefined, TOKEN_PROGRAM_ID);
    const a = { symbol, mint: mint.toBase58(), decimals: 6, tokenProgram: TOKEN_PROGRAM_ID.toBase58(), denominations: ["10", "100"] };
    await send([addAssetInstruction({ programId: PROGRAM_ID, admin: admin.publicKey, asset: a })]);
    return a;
  };
  EMPTY = await mk("EMPTY");
  FUNDED = await mk("FUNDED");
  const user = SolKeypair.generate();
  await connection.confirmTransaction(await connection.requestAirdrop(user.publicKey, 2 * LAMPORTS_PER_SOL), "confirmed");
  const ata = await getOrCreateAssociatedTokenAccount(connection, admin, new PublicKey(FUNDED.mint), user.publicKey, false, "confirmed");
  await mintTo(connection, admin, new PublicKey(FUNDED.mint), ata.address, admin, toRaw("100", 6));
  const m = new Map();
  const c = new SolMixClient({ connection, programId: PROGRAM_ID, keypair: new Keypair(), prove: proveNode, storage: { get: (k) => m.get(k), set: (k, v) => m.set(k, v) } });
  await c.shield({ asset: FUNDED, amount: toRaw("10", 6), wallet: { publicKey: user.publicKey, signTransaction: async (tx) => (tx.sign([user]), tx) } });
});

test("an asset can't be closed unless it was paused for the close delay", { skip: !enabled }, async () => {
  await rejects(close(EMPTY), /CloseNotAllowed|close delay/);
  await pause(EMPTY);
  await rejects(close(EMPTY), /CloseNotAllowed|close delay/);
});

test("an asset whose vault holds funds can never be closed", { skip: !enabled }, async () => {
  await pause(FUNDED);
  await pause(SOL);
  await wait(6500);
  await rejects(close(FUNDED), /VaultNotEmpty|still holds/);
  await rejects(close(SOL), /VaultNotEmpty|still holds/); // earlier suites left shielded SOL
  await pause(SOL, false);
});

test("an empty, paused asset closes and returns its rent; the pool stays until all assets are gone", { skip: !enabled }, async () => {
  const before = await assetCount();
  const balBefore = await connection.getBalance(admin.publicKey);
  await close(EMPTY);
  assert.equal(await connection.getAccountInfo(P.asset(EMPTY.mint)), null, "asset account closed");
  assert.equal(await connection.getAccountInfo(P.vault(EMPTY)), null, "vault closed");
  assert.equal(await assetCount(), before - 1n);
  assert.ok((await connection.getBalance(admin.publicKey)) > balBefore - 10_000, "rent came back (minus the fee)");
  await rejects(send([closePoolInstruction({ programId: PROGRAM_ID, admin: admin.publicKey })]), /VaultNotEmpty|still holds/);
});

test("only the admin can close", { skip: !enabled }, async () => {
  const stranger = SolKeypair.generate();
  await connection.confirmTransaction(await connection.requestAirdrop(stranger.publicKey, LAMPORTS_PER_SOL), "confirmed");
  await rejects(send([closeAssetInstruction({ programId: PROGRAM_ID, admin: stranger.publicKey, asset: FUNDED })], [stranger]), /Unauthorized|Only the pool admin/);
  await rejects(send([closePoolInstruction({ programId: PROGRAM_ID, admin: stranger.publicKey })], [stranger]), /Unauthorized|Only the pool admin/);
});
