// Copies proving artifacts and deployment data from the repo root into the web app.
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const web = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const root = path.resolve(web, "..");
const gen = path.join(web, "src", "generated");
const pub = path.join(web, "public", "circuits");
fs.mkdirSync(gen, { recursive: true });
fs.mkdirSync(pub, { recursive: true });

const copy = (from, to) => {
  const src = path.join(root, from);
  if (!fs.existsSync(src)) throw new Error(`missing ${from}; run the circuit build / deploy first`);
  const dst = path.join(to);
  if (!fs.existsSync(dst) || fs.statSync(dst).mtimeMs < fs.statSync(src).mtimeMs) fs.copyFileSync(src, dst);
};

copy("build/circuits/transaction_js/transaction.wasm", path.join(pub, "transaction.wasm"));
copy("build/circuits/transaction.zkey", path.join(pub, "transaction.zkey"));

const dep = JSON.parse(fs.readFileSync(path.join(root, "deployments/rhMainnet.json"), "utf8"));
const cfg = JSON.parse(fs.readFileSync(path.join(root, "config/assets.json"), "utf8"));

// company names from the Stock Token list
const names = {};
const rows = fs.readFileSync(path.join(root, "robinhood_stock_tokens.csv"), "utf8").trim().split(/\r?\n/).slice(1);
for (const r of rows) {
  const cols = [...r.matchAll(/("([^"]|"")*"|[^,]*)(,|$)/g)].map((m) => m[1].replace(/^"|"$/g, ""));
  names[cols[0]] = cols[1];
}

const assets = Object.entries(dep.assets).map(([symbol, a]) => ({
  symbol,
  address: a.address,
  decimals: a.decimals,
  kind: a.kind,
  name: a.kind === "ETH" ? "Ether" : a.kind === "USDG" ? "Global Dollar" : names[symbol] ?? symbol,
  denominations: cfg.denominations[a.kind],
}));

// Logos are downloaded once into public/logos and served from our own origin, so visitors'
// browsers never ping a third-party image host (that would leak who uses the app).
const logoDir = path.join(web, "public", "logos");
fs.mkdirSync(logoDir, { recursive: true });
const LOGO_SRC = {
  ETH: "https://coin-images.coingecko.com/coins/images/279/large/ethereum.png",
  USDG: "https://coin-images.coingecko.com/coins/images/51281/large/GDN_USDG_Token_200x200.png",
};
// White-on-transparent or dark-backed marks read better on a dark tile; the rest sit on white.
const DARK_TILE = new Set(["AMZN", "QQQ", "SPCX"]);
for (const a of assets) {
  const file = path.join(logoDir, `${a.symbol}.png`);
  if (!fs.existsSync(file)) {
    const url = LOGO_SRC[a.symbol] ?? `https://financialmodelingprep.com/image-stock/${a.symbol}.png`;
    try {
      const res = await fetch(url);
      const type = res.headers.get("content-type") ?? "";
      if (res.ok && type.startsWith("image/")) fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
      else console.warn(`no logo for ${a.symbol} (${res.status} ${type})`);
    } catch (e) {
      console.warn(`no logo for ${a.symbol}: ${e.message}`);
    }
  }
  a.logo = fs.existsSync(file) ? `/logos/${a.symbol}.png` : null;
  a.logoTile = a.kind === "STOCK" ? (DARK_TILE.has(a.symbol) ? "dark" : "light") : null;
}

fs.writeFileSync(
  path.join(gen, "deployment.json"),
  JSON.stringify({ chainId: dep.chainId, pool: dep.pool, verifier: dep.verifier, hasher: dep.hasher, deployBlock: dep.deployBlock, assets }, null, 2),
);
console.log(`synced ${assets.length} assets, pool ${dep.pool}`);
