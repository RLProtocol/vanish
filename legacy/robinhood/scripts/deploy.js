// Deploys Poseidon hasher + Verifier + RobinMix and registers assets.
//   mainnet:            ETH, USDG and the stock symbols in config/assets.json
//   testnet / local:    ETH plus freely mintable mock USDG / stock tokens
const fs = require("fs");
const path = require("path");
const hre = require("hardhat");
const { poseidonContract } = require("circomlibjs");
const cfg = require("../config/assets.json");
const { deploymentPath, loadStockList } = require("../src/lib/config");

const ERC20_META = ["function decimals() view returns (uint8)", "function symbol() view returns (string)"];

async function main() {
  const { ethers, network } = hre;
  const [deployer] = await ethers.getSigners();
  console.log(`network ${network.name}, deployer ${deployer.address}`);

  const hasher = await new ethers.ContractFactory(poseidonContract.generateABI(2), poseidonContract.createCode(2), deployer).deploy();
  await hasher.waitForDeployment();
  const verifier = await (await ethers.getContractFactory("Groth16Verifier")).deploy();
  await verifier.waitForDeployment();
  const pool = await (await ethers.getContractFactory("RobinMix")).deploy(verifier, hasher, 20, deployer.address);
  const deployTx = await pool.deploymentTransaction().wait();
  console.log(`RobinMix  ${pool.target} (block ${deployTx.blockNumber})`);

  // symbol -> {address, decimals, kind}
  const assets = { ETH: { address: ethers.ZeroAddress, decimals: 18, kind: "ETH" } };

  if (network.name === "rhMainnet") {
    assets.USDG = { address: cfg.rhMainnet.USDG, decimals: 6, kind: "USDG" };
    const list = loadStockList();
    for (const sym of cfg.rhMainnet.stocks) {
      if (!list[sym]) throw new Error(`${sym} is not a Robinhood Stock Token`);
      assets[sym] = { address: list[sym].contract_address, decimals: 18, kind: "STOCK" };
    }
    // sanity-check on-chain metadata before registering anything
    for (const [sym, a] of Object.entries(assets)) {
      if (a.kind === "ETH") continue;
      const t = new ethers.Contract(a.address, ERC20_META, deployer);
      const [dec, s] = [Number(await t.decimals()), await t.symbol()];
      if (dec !== a.decimals || s !== sym) throw new Error(`${sym}: on-chain says ${s} with ${dec} decimals`);
    }
  } else {
    const Mock = await ethers.getContractFactory("MockERC20");
    const mk = async (name, sym, dec, kind) => {
      const t = await Mock.deploy(name, sym, dec);
      await t.waitForDeployment();
      assets[sym] = { address: t.target, decimals: dec, kind, mock: true };
    };
    await mk("Mock Global Dollar", "USDG", 6, "USDG");
    for (const sym of cfg.mockStocks) await mk(`Mock ${sym} • Robinhood Token`, sym, 18, "STOCK");
  }

  for (const [sym, a] of Object.entries(assets)) {
    const denoms = cfg.denominations[a.kind].map((d) => ethers.parseUnits(d, a.decimals));
    await (await pool.addAsset(a.address, denoms)).wait();
    console.log(`  + ${sym.padEnd(6)} ${a.address}  deposits: ${cfg.denominations[a.kind].join(" / ")}`);
  }

  const out = {
    network: network.name,
    chainId: Number((await ethers.provider.getNetwork()).chainId),
    pool: pool.target,
    verifier: verifier.target,
    hasher: hasher.target,
    deployBlock: deployTx.blockNumber,
    assets,
  };
  fs.mkdirSync(path.dirname(deploymentPath(network.name)), { recursive: true });
  fs.writeFileSync(deploymentPath(network.name), JSON.stringify(out, null, 2));
  console.log(`saved ${path.relative(process.cwd(), deploymentPath(network.name))}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
