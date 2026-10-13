#!/usr/bin/env node
// Vanish CLI
//   node cli/vanish.mjs keygen
//   node cli/vanish.mjs assets
//   node cli/vanish.mjs balance
//   node cli/vanish.mjs shield   --asset SOL   --amount 0.1
//   node cli/vanish.mjs unshield --asset NVDAx --amount 3.5 --to <wallet> [--relayer https://...]
// Env: WALLET_KEYPAIR (Solana keypair JSON that pays fees), RPC_URL, PROGRAM_ID.
import fs from "fs";
import path from "path";
import { PublicKey } from "@solana/web3.js";
import { ASSETS, assetBySymbol } from "../sdk/assets.js";
import { Keypair } from "../sdk/crypto.js";
import { fromRaw, relayerEndpoint, toRaw } from "../sdk/solmix.js";
import { ROOT, loadSolKeypair, makeClient, walletOf } from "./common.mjs";

const KEY_FILE = path.join(ROOT, ".solmix", "wallet.json");

function args(argv) {
  const [cmd, ...rest] = argv;
  const o = {};
  for (let i = 0; i < rest.length; i++) {
    if (!rest[i].startsWith("--")) throw new Error(`unexpected ${rest[i]}`);
    o[rest[i].slice(2)] = rest[i + 1] && !rest[i + 1].startsWith("--") ? rest[++i] : true;
  }
  return { cmd, o };
}
const need = (v, msg) => {
  if (!v || v === true) throw new Error(msg);
  return v;
};
const shieldedKey = () => {
  if (!fs.existsSync(KEY_FILE)) throw new Error("no shielded key; run `keygen` first");
  return JSON.parse(fs.readFileSync(KEY_FILE, "utf8")).privkey;
};
const payer = () => walletOf(loadSolKeypair(need(process.env.WALLET_KEYPAIR, "set WALLET_KEYPAIR to the Solana keypair that pays fees")));
const stage = (s, sig) => console.log(`  ${s}${sig ? ` ${sig}` : ""}`);

const commands = {
  async keygen() {
    if (fs.existsSync(KEY_FILE)) throw new Error(`${KEY_FILE} exists; refusing to overwrite`);
    fs.mkdirSync(path.dirname(KEY_FILE), { recursive: true });
    fs.writeFileSync(KEY_FILE, JSON.stringify({ privkey: new Keypair().toString() }, null, 2));
    console.log(`shielded key saved to ${KEY_FILE}\nBack it up. Anyone with it can spend your notes; lose it and they're gone.`);
  },
  async assets() {
    for (const a of ASSETS) console.log(`${a.symbol.padEnd(6)} ${a.issuer.padEnd(20)} ${a.mint}  sizes: ${a.denominations.join(" / ")}`);
  },
  async balance() {
    const c = await makeClient(shieldedKey());
    const b = await c.getBalances();
    let any = false;
    for (const a of ASSETS) {
      if (!b[a.symbol].total) continue;
      any = true;
      console.log(`${a.symbol.padEnd(6)} ${fromRaw(b[a.symbol].total, a.decimals).padStart(14)}  (${b[a.symbol].notes} notes)`);
    }
    if (!any) console.log("nothing shielded");
  },
  async shield(o) {
    const a = assetBySymbol(need(o.asset, "--asset required"));
    const c = await makeClient(shieldedKey());
    const sig = await c.shield({ asset: a, amount: toRaw(need(o.amount, "--amount required"), a.decimals), wallet: payer(), onStage: stage });
    console.log(`shielded ${o.amount} ${a.symbol}: ${sig}`);
  },
  async unshield(o) {
    const a = assetBySymbol(need(o.asset, "--asset required"));
    const amount = toRaw(need(o.amount, "--amount required"), a.decimals);
    const to = new PublicKey(need(o.to, "--to <wallet address> required"));
    const c = await makeClient(shieldedKey());
    let relayer, fee = 0n, wallet = null;
    if (o.relayer) {
      const info = await (await fetch(relayerEndpoint(o.relayer, "/info"))).json();
      relayer = new PublicKey(info.address);
      const pct = (amount * BigInt(info.feeBps) + 9999n) / 10000n;
      const min = BigInt(info.minFees?.[a.mint] ?? 0);
      fee = pct > min ? pct : min;
      console.log(`relayer ${info.address}, fee ${fromRaw(fee, a.decimals)} ${a.symbol}`);
    } else {
      wallet = payer();
      console.log(`WARNING: ${wallet.publicKey.toBase58()} pays the fee and is visible as the signer. Use --relayer for privacy.`);
    }
    const sig = await c.unshield({ asset: a, amount, to, wallet, relayerUrl: o.relayer, relayer, fee, onStage: stage });
    console.log(`sent ${o.amount} ${a.symbol} to ${to.toBase58()}: ${sig}`);
  },
};

const { cmd, o } = args(process.argv.slice(2));
if (!commands[cmd]) {
  console.log("commands: keygen | assets | balance | shield | unshield");
  process.exit(cmd ? 1 : 0);
}
commands[cmd](o)
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(`error: ${e.message}`);
    if (e.logs) console.error(e.logs.slice(-6).join("\n"));
    process.exit(1);
  });
