// After `solana program deploy`: initialize the pool, list assets, create an address lookup table.
//   ADMIN_KEYPAIR=path/to/admin.json RPC_URL=https://... node scripts/setup.mjs
// Idempotent: skips anything that already exists. Writes deployments/mainnet.json.
import "dotenv/config";
import fs from "fs";
import path from "path";
import {
  AddressLookupTableProgram,
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { ASSOCIATED_TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { ASSETS, NATIVE_SOL, TOKEN_2022_PROGRAM, TOKEN_PROGRAM } from "../sdk/assets.js";
import { addAssetInstruction, initializeInstruction, pdas } from "../sdk/solmix.js";

const PROGRAM_ID = new PublicKey(process.env.PROGRAM_ID ?? "92DHWjMnbgcBdEmQ3hWoiJthFbP6Bk5e513pZAsQqoUG");
const RPC_URL = process.env.RPC_URL ?? "https://api.mainnet-beta.solana.com";
const keyPath = process.env.ADMIN_KEYPAIR ?? "keys/deployer.json";
const admin = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(keyPath, "utf8"))));
const connection = new Connection(RPC_URL, "confirmed");
const P = pdas(PROGRAM_ID);
const outPath = path.join("deployments", "mainnet.json");
const out = fs.existsSync(outPath) ? JSON.parse(fs.readFileSync(outPath, "utf8")) : {};

const send = (ixs) =>
  sendAndConfirmTransaction(
    connection,
    new Transaction().add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 20_000 }), ...ixs),
    [admin],
    { commitment: "confirmed" },
  );

console.log(`program ${PROGRAM_ID.toBase58()}  admin ${admin.publicKey.toBase58()}  rpc ${RPC_URL}`);
if (!(await connection.getAccountInfo(PROGRAM_ID))) throw new Error("program is not deployed yet");

if (!(await connection.getAccountInfo(P.pool))) {
  console.log("initialize pool:", await send([initializeInstruction({ programId: PROGRAM_ID, admin: admin.publicKey })]));
}

for (const asset of ASSETS) {
  if (await connection.getAccountInfo(P.asset(asset.mint))) {
    console.log(`  = ${asset.symbol} already listed`);
    continue;
  }
  const sig = await send([addAssetInstruction({ programId: PROGRAM_ID, admin: admin.publicKey, asset })]);
  console.log(`  + ${asset.symbol.padEnd(6)} ${asset.denominations.join(" / ")}  ${sig}`);
}

// Lookup table with every static account a transact can touch.
if (!out.lookupTable) {
  const slot = await connection.getSlot("finalized");
  const [create, table] = AddressLookupTableProgram.createLookupTable({ authority: admin.publicKey, payer: admin.publicKey, recentSlot: slot });
  await send([create]);
  const addresses = [
    PROGRAM_ID, P.pool, P.solVault, SystemProgram.programId, new PublicKey(TOKEN_PROGRAM), new PublicKey(TOKEN_2022_PROGRAM),
    ASSOCIATED_TOKEN_PROGRAM_ID, ComputeBudgetProgram.programId,
    // v2 swaps / private buys: wrapped SOL escrows and the Jupiter aggregator
    new PublicKey("So11111111111111111111111111111111111111112"), new PublicKey("JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4"),
    ...ASSETS.flatMap((a) => (a.mint === NATIVE_SOL ? [P.asset(a.mint)] : [P.asset(a.mint), new PublicKey(a.mint), P.vault(a)])),
  ];
  for (let i = 0; i < addresses.length; i += 20) {
    await send([AddressLookupTableProgram.extendLookupTable({ lookupTable: table, authority: admin.publicKey, payer: admin.publicKey, addresses: addresses.slice(i, i + 20) })]);
  }
  out.lookupTable = table.toBase58();
  console.log(`lookup table ${out.lookupTable} (${addresses.length} addresses)`);
}

Object.assign(out, { network: "mainnet-beta", programId: PROGRAM_ID.toBase58(), pool: P.pool.toBase58(), solVault: P.solVault.toBase58(), admin: admin.publicKey.toBase58() });
fs.mkdirSync("deployments", { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
console.log(`saved ${outPath}`);
