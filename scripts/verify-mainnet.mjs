// Read-only checks of the mainnet deployment, plus a simulated (not sent) shield with a real proof.
//   RPC_URL=... node scripts/verify-mainnet.mjs [path/to/payer.json]
import fs from "fs";
import { Connection, Keypair as SolKeypair, PublicKey, TransactionMessage, VersionedTransaction, ComputeBudgetProgram } from "@solana/web3.js";
import { ASSETS, NATIVE_SOL } from "../sdk/assets.js";
import { SolMixClient, pdas, transactInstruction, prepareTransaction, toRaw } from "../sdk/solmix.js";
import { Keypair, Utxo, assetId } from "../sdk/crypto.js";
import { proveNode } from "../sdk/prove-node.js";

const dep = JSON.parse(fs.readFileSync("deployments/mainnet.json", "utf8"));
const connection = new Connection(process.env.RPC_URL ?? "https://api.mainnet-beta.solana.com", "confirmed");
const PROGRAM_ID = new PublicKey(dep.programId);
const P = pdas(PROGRAM_ID);
let ok = true;
const check = (name, cond, extra = "") => {
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${extra ? `  ${extra}` : ""}`);
  ok &&= !!cond;
};

const program = await connection.getAccountInfo(PROGRAM_ID);
check("program is executable", program?.executable);

const pool = await connection.getAccountInfo(P.pool);
check("pool owned by program", pool?.owner.equals(PROGRAM_ID));
const admin = new PublicKey(pool.data.subarray(8, 40));
check("pool admin", admin.toBase58() === dep.admin, admin.toBase58());
const client = new SolMixClient({ connection, programId: PROGRAM_ID, keypair: new Keypair(), prove: proveNode });
const { nextIndex, root } = await client.readPool();
const { MerkleTree } = await import("../sdk/merkleTree.js");
check("on-chain root matches the SDK's tree", root === new MerkleTree(20, client.tree?.leaves ?? []).root || (nextIndex === 0 && root === new MerkleTree(20, []).root), `notes=${nextIndex}`);

const vaultSol = await connection.getAccountInfo(P.solVault);
check("SOL vault funded for rent", vaultSol && vaultSol.lamports > 0, `${vaultSol?.lamports} lamports`);

const assetKeys = ASSETS.map((a) => P.asset(a.mint));
const assetInfos = await connection.getMultipleAccountsInfo(assetKeys);
const vaultKeys = ASSETS.filter((a) => a.mint !== NATIVE_SOL).map((a) => P.vault(a));
const vaultInfos = await connection.getMultipleAccountsInfo(vaultKeys);
ASSETS.forEach((a, i) => {
  const info = assetInfos[i];
  const mint = info && new PublicKey(info.data.subarray(8, 40)).toBase58();
  const n = info && info.data.readUInt32LE(8 + 32 + 3);
  const denoms = info && Array.from({ length: n }, (_, k) => info.data.readBigUInt64LE(8 + 32 + 3 + 4 + 8 * k));
  const want = a.denominations.map((d) => toRaw(d, a.decimals)).sort((x, y) => (x < y ? -1 : 1));
  check(`asset ${a.symbol}`, info && mint === a.mint && JSON.stringify(denoms.map(String)) === JSON.stringify(want.map(String)), denoms?.map(String).join("/"));
});
ASSETS.filter((a) => a.mint !== NATIVE_SOL).forEach((a, i) => {
  const v = vaultInfos[i];
  const owner = v && new PublicKey(v.data.subarray(32, 64));
  check(`vault ${a.symbol}`, v && v.owner.toBase58() === a.tokenProgram && owner.equals(P.pool));
});

const lut = (await connection.getAddressLookupTable(new PublicKey(dep.lookupTable))).value;
check("lookup table", lut && lut.state.addresses.length >= 40, `${lut?.state.addresses.length} addresses`);

// Simulated shield of 0.1 SOL with a real Groth16 proof (nothing is sent).
const payerPath = process.argv[2];
if (payerPath) {
  const payer = SolKeypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(payerPath, "utf8"))));
  await client.sync();
  const SOL = ASSETS.find((a) => a.mint === NATIVE_SOL);
  const amount = toRaw("0.1", 9);
  const args = await prepareTransaction({
    tree: client.tree, asset: SOL, outputs: [new Utxo({ amount, assetId: assetId(new PublicKey(SOL.mint)), keypair: client.keypair })],
    extAmount: amount, recipient: payer.publicKey, relayer: payer.publicKey, keypair: client.keypair, prove: proveNode,
  });
  const ix = transactInstruction({ programId: PROGRAM_ID, signer: payer.publicKey, asset: SOL, recipient: payer.publicKey, relayer: payer.publicKey, args });
  const { blockhash } = await connection.getLatestBlockhash();
  const tx = new VersionedTransaction(
    new TransactionMessage({ payerKey: payer.publicKey, recentBlockhash: blockhash, instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }), ix] }).compileToV0Message([lut]),
  );
  tx.sign([payer]);
  const sim = await connection.simulateTransaction(tx, { sigVerify: true });
  check("simulated 0.1 SOL shield with a real proof", !sim.value.err, `${sim.value.unitsConsumed} CU, ${tx.serialize().length} bytes`);
  if (sim.value.err) console.log(sim.value.logs?.slice(-8).join("\n"));
}

console.log(ok ? "\nALL CHECKS PASSED" : "\nSOME CHECKS FAILED");
process.exit(ok ? 0 : 1);
