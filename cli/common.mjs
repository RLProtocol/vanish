import "dotenv/config";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { Connection, Keypair as SolKeypair, PublicKey } from "@solana/web3.js";
import { SolMixClient } from "../sdk/solmix.js";
import { Keypair } from "../sdk/crypto.js";
import { proveNode } from "../sdk/prove-node.js";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const depPath = path.join(ROOT, "deployments", "mainnet.json");
export const deployment = fs.existsSync(depPath) ? JSON.parse(fs.readFileSync(depPath, "utf8")) : {};
export const PROGRAM_ID = new PublicKey(process.env.PROGRAM_ID ?? deployment.programId ?? "92DHWjMnbgcBdEmQ3hWoiJthFbP6Bk5e513pZAsQqoUG");
export const connection = new Connection(process.env.RPC_URL ?? "https://api.mainnet-beta.solana.com", "confirmed");

export function loadSolKeypair(p) {
  return SolKeypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf8"))));
}
export const walletOf = (kp) => ({ publicKey: kp.publicKey, signTransaction: async (tx) => (tx.sign([kp]), tx) });

export async function lookupTable() {
  if (!deployment.lookupTable) return null;
  return (await connection.getAddressLookupTable(new PublicKey(deployment.lookupTable))).value;
}

/** Cache for the pool tree + discovered notes, one JSON file per key. */
export function fileStore(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const f = (k) => path.join(dir, k.replace(/[^a-z0-9]/gi, "_") + ".json");
  return { get: (k) => (fs.existsSync(f(k)) ? fs.readFileSync(f(k), "utf8") : null), set: (k, v) => fs.writeFileSync(f(k), v) };
}

export async function makeClient(shieldedKey) {
  return new SolMixClient({
    connection,
    programId: PROGRAM_ID,
    keypair: new Keypair(BigInt(shieldedKey)),
    prove: proveNode,
    storage: fileStore(path.join(ROOT, ".solmix", "cache")),
    lookupTable: await lookupTable(),
  });
}
