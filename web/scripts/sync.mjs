// Copies proving artifacts, deployment info and asset logos into the web app.
// Logos are self-hosted so visitors' browsers never contact a third-party image host.
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { ASSETS } from "../../sdk/assets.js";

const web = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const root = path.resolve(web, "..");
const gen = path.join(web, "src", "generated");
const pub = path.join(web, "public", "circuits");
const logoDir = path.join(web, "public", "logos");
for (const d of [gen, pub, logoDir]) fs.mkdirSync(d, { recursive: true });

const copy = (from, to) => {
  const src = path.join(root, from);
  if (!fs.existsSync(src)) throw new Error(`missing ${from}; build the circuit first`);
  if (!fs.existsSync(to) || fs.statSync(to).mtimeMs < fs.statSync(src).mtimeMs) fs.copyFileSync(src, to);
};
copy("build/circuits/transaction_js/transaction.wasm", path.join(pub, "transaction.wasm"));
copy("build/circuits/transaction.zkey", path.join(pub, "transaction.zkey"));

const depFile = path.join(root, "deployments", "mainnet.json");
const dep = fs.existsSync(depFile) ? JSON.parse(fs.readFileSync(depFile, "utf8")) : {};
fs.writeFileSync(
  path.join(gen, "deployment.json"),
  JSON.stringify({ programId: dep.programId ?? "92DHWjMnbgcBdEmQ3hWoiJthFbP6Bk5e513pZAsQqoUG", lookupTable: dep.lookupTable ?? null, deployed: !!dep.programId }, null, 2),
);

const COIN_LOGOS = {
  SOL: "https://coin-images.coingecko.com/coins/images/4128/large/solana.png",
  USDC: "https://coin-images.coingecko.com/coins/images/6319/large/usdc.png",
  USDT: "https://coin-images.coingecko.com/coins/images/325/large/Tether.png",
  USDG: "https://coin-images.coingecko.com/coins/images/51281/large/GDN_USDG_Token_200x200.png",
};
// Logos are background-free (scripts/clean-logos.py); single-colour marks are drawn in the text colour.
const metaFile = path.join(web, "src", "logos-meta.json");
const meta = fs.existsSync(metaFile) ? JSON.parse(fs.readFileSync(metaFile, "utf8")) : {};
const logos = {};
for (const a of ASSETS) {
  const key = a.kind === "stock" ? a.underlying : a.symbol;
  const svg = path.join(logoDir, `${key}.svg`); // hand-made vector marks take precedence
  if (fs.existsSync(svg)) {
    logos[a.symbol] = { src: `/logos/${key}.svg`, mono: !!meta[key]?.mono };
    continue;
  }
  const file = path.join(logoDir, `${key}.png`);
  if (!fs.existsSync(file)) {
    const url = COIN_LOGOS[key] ?? `https://financialmodelingprep.com/image-stock/${key}.png`;
    try {
      const res = await fetch(url);
      if (res.ok && (res.headers.get("content-type") ?? "").startsWith("image/")) fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
      else console.warn(`no logo for ${key} (${res.status})`);
    } catch (e) {
      console.warn(`no logo for ${key}: ${e.message}`);
    }
  }
  if (fs.existsSync(file)) logos[a.symbol] = { src: `/logos/${key}.png`, mono: !!meta[key]?.mono };
}
fs.writeFileSync(path.join(gen, "logos.json"), JSON.stringify(logos, null, 2));
console.log(`synced ${ASSETS.length} assets, ${Object.keys(logos).length} logos, program ${dep.programId ?? "(not deployed yet)"}`);
