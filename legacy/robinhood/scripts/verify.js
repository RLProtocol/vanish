// Publishes source for a deployment and checks the hasher bytecode.
//   npx hardhat run scripts/verify.js --network rhMainnet
//
// - Verifier + RobinMix are submitted to Sourcify v2 (no key) and, if ETHERSCAN_API_KEY is set,
//   to Etherscan v2 (robin.etherscan.io), using the exact compiler input from Hardhat's build-info.
// - The Poseidon hasher has no Solidity source (circomlibjs emits raw bytecode), so instead we
//   regenerate it and compare runtime bytecode with what's on-chain.
const fs = require("fs");
const path = require("path");
const hre = require("hardhat");
const { poseidonContract } = require("circomlibjs");
const { deploymentPath } = require("../src/lib/config");

const SOURCIFY = "https://sourcify.dev/server";

const ETHERSCAN = "https://api.etherscan.io/v2/api";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function buildInfo(fqName) {
  const [file, name] = fqName.split(":");
  const dbgPath = path.join(hre.config.paths.artifacts, file, `${name}.dbg.json`);
  const dbg = JSON.parse(fs.readFileSync(dbgPath, "utf8"));
  return JSON.parse(fs.readFileSync(path.resolve(path.dirname(dbgPath), dbg.buildInfo), "utf8"));
}

async function sourcify(chainId, address, fqName) {
  const bi = buildInfo(fqName);

  const res = await fetch(`${SOURCIFY}/v2/verify/${chainId}/${address}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ stdJsonInput: bi.input, compilerVersion: bi.solcLongVersion, contractIdentifier: fqName }),
  });
  const body = await res.json();
  if (res.status === 409) return "already verified";
  if (!body.verificationId) throw new Error(`${fqName}: ${JSON.stringify(body)}`);

  for (let i = 0; i < 30; i++) {
    await sleep(2000);
    const job = await (await fetch(`${SOURCIFY}/v2/verify/${body.verificationId}`)).json();
    if (job.isJobCompleted) {
      if (job.error?.customCode === "already_verified" || /already verified/i.test(job.error?.message ?? "")) return "already verified";
      if (job.error) throw new Error(`${fqName}: ${job.error.message ?? JSON.stringify(job.error)}`);
      return job.contract.match;
    }
  }
  throw new Error(`${fqName}: sourcify job timed out`);
}

// Etherscan v2 (robin.etherscan.io). Called directly because hardhat-verify blocks
// indefinitely while this chain's verification queue says "Pending in queue".
async function etherscan(chainId, address, fqName, encodedArgs) {
  const key = process.env.ETHERSCAN_API_KEY.trim();
  const api = `${ETHERSCAN}?chainid=${chainId}`;
  const src = await (await fetch(`${api}&module=contract&action=getsourcecode&address=${address}&apikey=${key}`)).json();
  if (src.result?.[0]?.SourceCode) return "already verified";

  const bi = buildInfo(fqName);
  const form = new URLSearchParams({
    apikey: key, module: "contract", action: "verifysourcecode", contractaddress: address,
    sourceCode: JSON.stringify(bi.input), codeformat: "solidity-standard-json-input",
    contractname: fqName, compilerversion: `v${bi.solcLongVersion}`, constructorArguements: encodedArgs.replace(/^0x/, ""),
  });
  const sub = await (await fetch(api, { method: "POST", body: form })).json();
  if (sub.status !== "1") return /already verified/i.test(sub.result) ? "already verified" : `rejected: ${sub.result}`;

  for (let i = 0; i < 24; i++) {
    await sleep(5000);
    const st = await (await fetch(`${api}&module=contract&action=checkverifystatus&guid=${sub.result}&apikey=${key}`)).json();
    if (!/pending/i.test(st.result)) return st.result;
  }
  return `still queued (guid ${sub.result}); check the explorer later`;
}

async function main() {
  const d = JSON.parse(fs.readFileSync(deploymentPath(hre.network.name), "utf8"));

  for (const [addr, fq] of [
    [d.verifier, "contracts/Verifier.sol:Groth16Verifier"],
    [d.pool, "contracts/RobinMix.sol:RobinMix"],
  ]) {
    console.log(`${fq.padEnd(40)} ${addr}  sourcify: ${await sourcify(d.chainId, addr, fq)}`);
  }

  if (process.env.ETHERSCAN_API_KEY) {
    const owner = await (await hre.ethers.getContractAt("RobinMix", d.pool)).owner();
    const poolArgs = hre.ethers.AbiCoder.defaultAbiCoder().encode(["address", "address", "uint32", "address"], [d.verifier, d.hasher, 20, owner]);
    for (const [addr, fq, args] of [
      [d.verifier, "contracts/Verifier.sol:Groth16Verifier", "0x"],
      [d.pool, "contracts/RobinMix.sol:RobinMix", poolArgs],
    ]) {
      console.log(`${fq.padEnd(40)} ${addr}  etherscan: ${await etherscan(d.chainId, addr, fq, args)}`);
    }
  } else {
    console.log("(set ETHERSCAN_API_KEY to also verify on robin.etherscan.io)");
  }

  // eth_call with no `to` runs the init code and returns the runtime bytecode it would deploy
  const expected = await hre.ethers.provider.call({ data: poseidonContract.createCode(2) });
  const onchain = await hre.ethers.provider.getCode(d.hasher);
  console.log(`${"PoseidonT3 (circomlibjs)".padEnd(40)} ${d.hasher}  bytecode: ${onchain === expected ? "matches circomlibjs" : "MISMATCH"}`);
  console.log(`\nhttps://repo.sourcify.dev/${d.chainId}/${d.pool}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
