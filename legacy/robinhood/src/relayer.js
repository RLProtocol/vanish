#!/usr/bin/env node
// Minimal relayer: submits users' withdrawals so their own address never touches the pool.
// It pays gas in ETH and is paid a fee (in the withdrawn asset) that is bound into the proof.
//
//   RELAYER_PRIVATE_KEY=0x... NETWORK=rhTestnet PORT=8000 FEE_BPS=30 node src/relayer.js
require("dotenv").config();
const http = require("http");
const { JsonRpcProvider, Wallet, Contract } = require("ethers");
const { POOL_ABI } = require("./lib/client");
const { NETWORKS, loadDeployment } = require("./lib/config");

const network = process.env.NETWORK || "rhTestnet";
const PORT = Number(process.env.PORT || 8000);
const FEE_BPS = BigInt(process.env.FEE_BPS || 30);
const ALLOW_FREE_MERGES = process.env.ALLOW_FREE_MERGES === "true";

const dep = loadDeployment(network);
const provider = new JsonRpcProvider(NETWORKS[network].rpc, NETWORKS[network].chainId);
const wallet = new Wallet(process.env.RELAYER_PRIVATE_KEY || "", provider);
const pool = new Contract(dep.pool, POOL_ABI, wallet);

function parse(body) {
  const { args, extData } = JSON.parse(body);
  args.publicAmount = BigInt(args.publicAmount);
  extData.extAmount = BigInt(extData.extAmount);
  extData.fee = BigInt(extData.fee);
  return { args, extData };
}

function check({ extData }) {
  if (extData.relayer.toLowerCase() !== wallet.address.toLowerCase()) return "extData.relayer is not this relayer";
  if (extData.extAmount > 0n) return "relayer does not submit deposits";
  if (extData.extAmount === 0n) return extData.fee > 0n || ALLOW_FREE_MERGES ? null : "merge needs a fee";
  const minFee = (-extData.extAmount * FEE_BPS + 9999n) / 10000n;
  return extData.fee >= minFee ? null : `fee too low, need >= ${minFee}`;
}

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "content-type",
};
const send = (res, code, obj) => {
  res.writeHead(code, { "content-type": "application/json", ...CORS });
  res.end(JSON.stringify(obj));
};

http
  .createServer(async (req, res) => {
    try {
      if (req.method === "OPTIONS") {
        res.writeHead(204, CORS);
        return res.end();
      }
      if (req.method === "GET" && req.url === "/info") {
        return send(res, 200, { address: wallet.address, pool: dep.pool, chainId: dep.chainId, feeBps: Number(FEE_BPS) });
      }
      if (req.method === "POST" && req.url === "/relay") {
        let body = "";
        for await (const chunk of req) {
          body += chunk;
          if (body.length > 64 * 1024) return send(res, 413, { error: "body too large" });
        }
        const tx = parse(body);
        const err = check(tx);
        if (err) return send(res, 400, { error: err });
        await pool.transact.staticCall(tx.args, tx.extData); // reverts early on bad proofs / spent notes
        const sent = await pool.transact(tx.args, tx.extData);
        console.log(`relayed ${sent.hash}`);
        return send(res, 200, { txHash: sent.hash });
      }
      send(res, 404, { error: "not found" });
    } catch (e) {
      send(res, 400, { error: e.shortMessage ?? e.message });
    }
  })
  .listen(PORT, () => console.log(`relayer ${wallet.address} for pool ${dep.pool} on ${network}, :${PORT}, fee ${FEE_BPS} bps`));
