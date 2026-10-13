// SDK unit tests (no chain needed): node --test tests/sdk.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import * as snarkjs from "snarkjs";
import { PublicKey, Keypair as SolKeypair } from "@solana/web3.js";
import { Keypair, Utxo, assetId } from "../sdk/crypto.js";
import { MerkleTree } from "../sdk/merkleTree.js";
import { prepareTransaction, parseTransactEvents, transactInstruction, toRaw, fromRaw } from "../sdk/solmix.js";
import { assetBySymbol } from "../sdk/assets.js";
import { proveNode } from "../sdk/prove-node.js";

const PROGRAM_ID = "92DHWjMnbgcBdEmQ3hWoiJthFbP6Bk5e513pZAsQqoUG";

test("notes encrypt to 68 bytes and only their owner can read them", async () => {
  const kp = new Keypair();
  const enc = await kp.encrypt(123456789n, 42n);
  assert.equal(enc.length, 68);
  assert.deepEqual(await kp.decrypt(enc), { amount: 123456789n, blinding: 42n });
  assert.equal(await new Keypair().decrypt(enc), null);
});

test("amount helpers and asset ids", () => {
  assert.equal(toRaw("0.1", 9), 100000000n);
  assert.equal(fromRaw(1234500000n, 8), "12.345");
  assert.equal(assetId(new PublicKey("11111111111111111111111111111111")), 0n);
});

test("withdrawal proof verifies and encodes into a 13-account transact instruction", async () => {
  const kp = new Keypair();
  const nvda = assetBySymbol("NVDAx");
  const id = assetId(new PublicKey(nvda.mint));
  const note = new Utxo({ amount: toRaw("10", 8), assetId: id, keypair: kp, index: 0 });
  const tree = new MerkleTree(20, [note.getCommitment(), new Utxo({ assetId: id }).getCommitment()]);
  let captured;
  const prove = async (input) => {
    const p = await proveNode(input);
    captured = { input, p };
    return p;
  };
  const recipient = SolKeypair.generate().publicKey;
  const args = await prepareTransaction({
    tree, asset: nvda, inputs: [note], outputs: [new Utxo({ amount: toRaw("6.5", 8), assetId: id, keypair: kp })],
    extAmount: -toRaw("3.5", 8), recipient, relayer: recipient, keypair: kp, prove,
  });

  const vk = JSON.parse(fs.readFileSync("build/circuits/verification_key.json"));
  const i = captured.input;
  const pub = [i.root, i.publicAmount, i.extDataHash, i.assetId, ...i.inputNullifier, ...i.outputCommitment].map(String);
  assert.ok(await snarkjs.groth16.verify(vk, pub, captured.p), "snarkjs verifies the proof");
  assert.equal(args.proof.length, 256);

  const ix = transactInstruction({ programId: PROGRAM_ID, signer: recipient, asset: nvda, recipient, relayer: recipient, args });
  assert.equal(ix.keys.length, 13);
  assert.equal(ix.data.length, 8 + 4 + 256 + 32 + 64 + 64 + 8 + 8 + 4 + 68 + 4 + 68);
});

test("TransactEvent log lines decode", () => {
  const bytes = Buffer.alloc(8 + 32 + 8 + 128 + 4 + 68 + 4 + 68 + 16);
  Buffer.from([89, 245, 87, 250, 222, 30, 135, 142]).copy(bytes, 0);
  bytes.writeBigUInt64LE(6n, 40);
  bytes.writeUInt32LE(68, 176);
  bytes.writeUInt32LE(68, 248);
  bytes.writeBigInt64LE(-5n, 320);
  const [e] = parseTransactEvents([`Program data: ${bytes.toString("base64")}`]);
  assert.equal(e.firstIndex, 6);
  assert.equal(e.enc[0].length, 68);
  assert.equal(e.extAmount, -5n);
});
