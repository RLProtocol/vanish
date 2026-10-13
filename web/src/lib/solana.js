// Browser glue: RPC connection, injected Solana wallets, the proof worker and the SDK client.
import { Connection, PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { SolMixClient, pdas, fromRaw, getAccountsChunked } from "sdk/solmix.js";
import { Keypair } from "sdk/crypto.js";
import { ASSETS, NATIVE_SOL } from "sdk/assets.js";
import { stringifyInput } from "sdk/solmix.js";
import deployment from "../generated/deployment.json";
import logos from "../generated/logos.json";

export { ASSETS, NATIVE_SOL, deployment, logos, fromRaw };
export const PROGRAM_ID = new PublicKey(deployment.programId);
export const EXPLORER = "https://solscan.io";
// The Vanish relayer every withdrawal goes through (set VITE_RELAYER_URL at build time).
export const RELAYER_URL = import.meta.env.VITE_RELAYER_URL || "";
export const P = pdas(PROGRAM_ID);

// api.mainnet-beta.solana.com refuses browser requests (403), so the site defaults to PublicNode,
// which allows them. People can bring their own (Helius, Triton, QuickNode...) in Settings.
export const DEFAULT_RPC = "https://solana-rpc.publicnode.com";
export function getRpc() {
  try {
    return localStorage.getItem("solmix:rpc") || DEFAULT_RPC;
  } catch {
    return DEFAULT_RPC;
  }
}
export function setRpc(url) {
  try {
    if (url) localStorage.setItem("solmix:rpc", url);
    else localStorage.removeItem("solmix:rpc");
  } catch {}
  connection = new Connection(getRpc(), "confirmed");
}
export let connection = new Connection(getRpc(), "confirmed");

// ---------------------------------------------------------------------------- wallets (see wallets.js)

export const KEY_MESSAGE = [
  "SolMix private key",
  "",
  "Sign to unlock your private balance.",
  "This signature never leaves your browser and costs nothing.",
  "",
  `Program: ${PROGRAM_ID.toBase58()}`,
].join("\n");

/** Same wallet + same message => same shielded key on any device (ed25519 signatures are deterministic). */
export async function keypairFromWallet(wallet) {
  const sig = await wallet.signMessage(new TextEncoder().encode(KEY_MESSAGE));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array([...new TextEncoder().encode("solmix-shielded-key:"), ...sig])));
  const k = BigInt("0x" + Array.from(digest.subarray(0, 31), (b) => b.toString(16).padStart(2, "0")).join(""));
  return new Keypair(k === 0n ? 1n : k);
}

// ---------------------------------------------------------------------------- prover

let worker = null;
let nextId = 0;
const pending = new Map();
function getWorker() {
  if (!worker) {
    worker = new Worker(new URL("./prover.worker.js", import.meta.url), { type: "module" });
    worker.onmessage = ({ data }) => {
      const p = pending.get(data.id);
      if (!p) return;
      if (data.type === "progress") p.onProgress?.(data);
      else {
        pending.delete(data.id);
        data.type === "done" ? p.resolve(data.proof) : p.reject(new Error(data.error));
      }
    };
  }
  return worker;
}
export function proveInBrowser(input, onProgress) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject, onProgress });
    getWorker().postMessage({ id, input: input && stringifyInput(input) });
  });
}
/** Start downloading the proving key before the first click. */
export const preloadProver = (onProgress) => proveInBrowser(null, onProgress).catch(() => {});

// ---------------------------------------------------------------------------- client + stats

const storage = {
  get: (k) => {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set: (k, v) => {
    try {
      localStorage.setItem(k, v);
    } catch {}
  },
};

let lut;
export async function makeClient(keypair) {
  if (lut === undefined) {
    lut = deployment.lookupTable ? (await connection.getAddressLookupTable(new PublicKey(deployment.lookupTable))).value : null;
  }
  return new SolMixClient({ connection, programId: PROGRAM_ID, keypair, prove: proveInBrowser, storage, lookupTable: lut });
}

/** Public numbers for the landing page: transactions and what each vault holds. */
export async function getPoolStats() {
  if (!deployment.deployed) return null;
  const tokenAssets = ASSETS.filter((a) => a.mint !== NATIVE_SOL);
  const keys = [P.pool, P.solVault, ...tokenAssets.map((a) => P.vault(a))];
  const infos = await getAccountsChunked(connection, keys);
  if (!infos[0]) return null;
  const nextIndex = Number(new DataView(infos[0].data.buffer, infos[0].data.byteOffset).getBigUint64(40, true));
  const rent = 890880n;
  const balances = { SOL: infos[1] ? BigInt(infos[1].lamports) - rent : 0n };
  tokenAssets.forEach((a, i) => {
    const d = infos[i + 2]?.data;
    balances[a.symbol] = d ? new DataView(d.buffer, d.byteOffset).getBigUint64(64, true) : 0n;
  });
  return { transactions: nextIndex / 2, notes: nextIndex, balances };
}

export async function getWalletBalance(asset, owner) {
  if (asset.mint === NATIVE_SOL) return BigInt(await connection.getBalance(owner, "confirmed"));
  const ata = getAssociatedTokenAddressSync(new PublicKey(asset.mint), owner, false, new PublicKey(asset.tokenProgram));
  try {
    const r = await connection.getTokenAccountBalance(ata, "confirmed");
    return BigInt(r.value.amount);
  } catch {
    return 0n;
  }
}

/** Wallet errors -> one line people can act on. */
export function explainError(e) {
  const msg = e?.message ?? String(e);
  if (e?.code === 4001 || /reject|declined|cancel/i.test(msg)) return "You rejected the request in your wallet.";
  if (/insufficient (funds|lamports)|0x1\b/i.test(msg)) return "Your wallet doesn't have enough for this amount plus fees.";
  if (/429|Too Many Requests/i.test(msg)) return "The RPC is rate limiting you. Add your own RPC URL in settings.";
  return msg;
}
