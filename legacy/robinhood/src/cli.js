#!/usr/bin/env node
// RobinMix CLI
//   node src/cli.js keygen
//   node src/cli.js info     --network rhTestnet
//   node src/cli.js balance  --network rhTestnet [--asset ETH]
//   node src/cli.js deposit  --network rhTestnet --asset ETH  --amount 0.1
//   node src/cli.js withdraw --network rhTestnet --asset NVDA --amount 3.5 --to 0x... [--relayer http://host:8000]
//   node src/cli.js mint     --network rhTestnet --asset USDG --amount 1000    (mock tokens only)
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { JsonRpcProvider, Wallet, Contract, formatUnits, parseUnits, isAddress } = require("ethers");
const { initPoseidon, Keypair } = require("./lib/crypto");
const { RobinMixClient } = require("./lib/client");
const { ROOT, NETWORKS, loadDeployment, resolveAsset } = require("./lib/config");

const WALLET_DIR = path.join(ROOT, ".robinmix");
const WALLET_FILE = path.join(WALLET_DIR, "wallet.json");

function parseArgs(argv) {
  const [cmd, ...rest] = argv;
  const opts = {};
  for (let i = 0; i < rest.length; i++) {
    if (!rest[i].startsWith("--")) throw new Error(`unexpected argument ${rest[i]}`);
    opts[rest[i].slice(2)] = rest[i + 1]?.startsWith("--") || rest[i + 1] === undefined ? true : rest[++i];
  }
  return { cmd, opts };
}

function loadKeypair() {
  if (!fs.existsSync(WALLET_FILE)) throw new Error("no shielded wallet; run `keygen` first");
  return new Keypair(BigInt(JSON.parse(fs.readFileSync(WALLET_FILE, "utf8")).privkey));
}

function setup(opts) {
  const network = opts.network || "rhTestnet";
  if (!NETWORKS[network]) throw new Error(`unknown network ${network}`);
  const dep = loadDeployment(network);
  const provider = new JsonRpcProvider(NETWORKS[network].rpc, NETWORKS[network].chainId);
  const signer = process.env.PRIVATE_KEY ? new Wallet(process.env.PRIVATE_KEY, provider) : null;
  const keypair = loadKeypair();
  const client = new RobinMixClient({
    poolAddress: dep.pool,
    runner: signer ?? provider,
    keypair,
    deployBlock: dep.deployBlock,
    cacheFile: path.join(WALLET_DIR, `cache-${network}-${dep.pool.toLowerCase()}.json`),
  });
  return { network, dep, provider, signer, client };
}

const need = (v, msg) => {
  if (!v || v === true) throw new Error(msg);
  return v;
};
const requireSigner = (signer) => need(signer, "set PRIVATE_KEY in .env (the account that pays gas)");

const commands = {
  async keygen() {
    if (fs.existsSync(WALLET_FILE)) throw new Error(`${WALLET_FILE} already exists; refusing to overwrite your notes' key`);
    fs.mkdirSync(WALLET_DIR, { recursive: true });
    const kp = new Keypair();
    fs.writeFileSync(WALLET_FILE, JSON.stringify({ privkey: "0x" + kp.privkey.toString(16) }, null, 2));
    console.log(`shielded key saved to ${WALLET_FILE}`);
    console.log("BACK THIS FILE UP. Anyone with it can spend your notes; lose it and the funds are gone.");
  },

  async info(opts) {
    const network = opts.network || "rhTestnet";
    const dep = loadDeployment(network);
    console.log(`pool ${dep.pool} on ${network} (chain ${dep.chainId})`);
    for (const [sym, a] of Object.entries(dep.assets)) {
      const cfg = require("../config/assets.json").denominations[a.kind];
      console.log(`  ${sym.padEnd(6)} ${a.address}${a.mock ? " (mock)" : ""}  deposits: ${cfg.join(" / ")}`);
    }
  },

  async balance(opts) {
    const { dep, client } = setup(opts);
    const syms = opts.asset ? [opts.asset] : Object.keys(dep.assets);
    for (const s of syms) {
      const a = resolveAsset(dep, s);
      const { total, notes } = await client.balance(a.address);
      if (total > 0n || opts.asset) console.log(`${a.symbol.padEnd(6)} ${formatUnits(total, a.decimals)}  (${notes} note${notes === 1 ? "" : "s"})`);
    }
  },

  async deposit(opts) {
    const { dep, signer, client } = setup(opts);
    requireSigner(signer);
    const a = resolveAsset(dep, need(opts.asset, "--asset required"));
    const amount = parseUnits(need(opts.amount, "--amount required"), a.decimals);
    const allowed = (await client.pool.getDenominations(a.address)).map((d) => formatUnits(d, a.decimals).replace(/\.0$/, ""));
    if (!allowed.includes(formatUnits(amount, a.decimals).replace(/\.0$/, ""))) {
      throw new Error(`deposits of ${a.symbol} must be exactly one of: ${allowed.join(" / ")} (withdrawals can be any amount)`);
    }
    console.log(`proving + depositing ${opts.amount} ${a.symbol} from ${signer.address} ...`);
    const r = await client.deposit({ token: a.address, amount, signer });
    console.log(`done: ${r.hash}`);
    console.log("tip: wait for more deposits of the same size before withdrawing; a quick in-and-out is easy to link.");
  },

  async withdraw(opts) {
    const { dep, signer, client } = setup(opts);
    const a = resolveAsset(dep, need(opts.asset, "--asset required"));
    const amount = parseUnits(need(opts.amount, "--amount required"), a.decimals);
    const recipient = need(opts.to, "--to <address> required");
    if (!isAddress(recipient)) throw new Error("--to is not an address");

    let relayer, fee = 0n, relayerUrl;
    if (opts.relayer) {
      relayerUrl = opts.relayer;
      const info = await (await fetch(new URL("/info", relayerUrl))).json();
      if (info.pool.toLowerCase() !== dep.pool.toLowerCase()) throw new Error("relayer serves a different pool");
      relayer = info.address;
      fee = (amount * BigInt(info.feeBps) + 9999n) / 10000n;
      console.log(`relayer ${relayer} fee ${formatUnits(fee, a.decimals)} ${a.symbol} (${info.feeBps / 100}%)`);
    } else {
      requireSigner(signer);
      console.log(`WARNING: no --relayer; ${signer.address} pays gas and is publicly visible as the sender.`);
      console.log("         Use a relayer (or a fresh gas-only address) if that address is linked to your deposit.");
    }

    console.log(`proving + withdrawing ${opts.amount} ${a.symbol} to ${recipient} ...`);
    const r = await client.withdraw({
      token: a.address, amount, recipient, signer, relayerUrl, relayer, fee,
      onMerge: () => console.log("  merging notes privately first (withdrawal needs >2 notes) ..."),
    });
    console.log(`done: ${r.hash}`);
    const { total } = await client.balance(a.address);
    console.log(`remaining shielded ${a.symbol}: ${formatUnits(total, a.decimals)}`);
  },

  async mint(opts) {
    const { dep, signer } = setup(opts);
    requireSigner(signer);
    const a = resolveAsset(dep, need(opts.asset, "--asset required"));
    if (!a.mock) throw new Error(`${a.symbol} is not a mock token`);
    const t = new Contract(a.address, ["function mint(address,uint256)"], signer);
    await (await t.mint(signer.address, parseUnits(need(opts.amount, "--amount required"), a.decimals))).wait();
    console.log(`minted ${opts.amount} ${a.symbol} to ${signer.address}`);
  },
};

async function main() {
  const { cmd, opts } = parseArgs(process.argv.slice(2));
  if (!commands[cmd]) {
    console.log("commands: keygen | info | balance | deposit | withdraw | mint   (see header of src/cli.js)");
    process.exit(cmd ? 1 : 0);
  }
  await initPoseidon();
  await commands[cmd](opts);
  process.exit(0); // snarkjs keeps worker threads alive
}

main().catch((e) => {
  console.error(`error: ${e.shortMessage ?? e.message}`);
  process.exit(1);
});
