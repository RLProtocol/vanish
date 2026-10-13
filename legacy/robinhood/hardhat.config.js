require("@nomicfoundation/hardhat-toolbox");
require("dotenv").config();

const accounts = process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [];

module.exports = {
  solidity: {
    version: "0.8.28",
    settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: "cancun" },
  },
  networks: {
    localhost: { url: process.env.LOCAL_RPC || "http://127.0.0.1:8545" },
    rhMainnet: {
      url: process.env.RH_MAINNET_RPC || "https://rpc.mainnet.chain.robinhood.com",
      chainId: 4663,
      accounts,
    },
    rhTestnet: {
      url: process.env.RH_TESTNET_RPC || "https://rpc.testnet.chain.robinhood.com",
      chainId: 46630,
      accounts,
    },
  },
  // robin.etherscan.io via the Etherscan v2 API: one etherscan.io key covers every chain.
  // Sourcify (no key) is handled by scripts/verify.js; the Blockscout API sits behind Cloudflare.
  etherscan: {
    enabled: !!process.env.ETHERSCAN_API_KEY,
    apiKey: process.env.ETHERSCAN_API_KEY || "",
    customChains: [
      { network: "rhMainnet", chainId: 4663, urls: { apiURL: "https://api.etherscan.io/v2/api", browserURL: "https://robin.etherscan.io" } },
    ],
  },
  sourcify: { enabled: false },
  mocha: { timeout: 600000 },
};
