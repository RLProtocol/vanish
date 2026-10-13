const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..", "..");

const NETWORKS = {
  rhMainnet: { chainId: 4663, rpc: process.env.RH_MAINNET_RPC || "https://rpc.mainnet.chain.robinhood.com", explorer: "https://robin.etherscan.io" },
  rhTestnet: { chainId: 46630, rpc: process.env.RH_TESTNET_RPC || "https://rpc.testnet.chain.robinhood.com", explorer: "https://explorer.testnet.chain.robinhood.com" },
  localhost: { chainId: 31337, rpc: process.env.LOCAL_RPC || "http://127.0.0.1:8545", explorer: null },
};

const deploymentPath = (network) => path.join(ROOT, "deployments", `${network}.json`);

function loadDeployment(network) {
  const p = deploymentPath(network);
  if (!fs.existsSync(p)) throw new Error(`no deployment for ${network}; run the deploy script first`);
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function resolveAsset(deployment, symbol) {
  const a = deployment.assets[symbol.toUpperCase()];
  if (!a) throw new Error(`asset ${symbol} not in pool; available: ${Object.keys(deployment.assets).join(", ")}`);
  return { symbol: symbol.toUpperCase(), ...a };
}

/** symbol -> {address, isin, name} from the Robinhood Stock Token list. */
function loadStockList() {
  const rows = fs.readFileSync(path.join(ROOT, "robinhood_stock_tokens.csv"), "utf8").trim().split(/\r?\n/);
  const split = (line) => [...line.matchAll(/("([^"]|"")*"|[^,]*)(,|$)/g)].slice(0, -1).map((m) => m[1].replace(/^"|"$/g, "").replace(/""/g, '"'));
  const header = split(rows.shift());
  const out = {};
  for (const row of rows) {
    const cols = split(row);
    const rec = Object.fromEntries(header.map((h, i) => [h, cols[i]]));
    out[rec.symbol] = rec;
  }
  return out;
}

module.exports = { ROOT, NETWORKS, deploymentPath, loadDeployment, resolveAsset, loadStockList };
