// Assets listed in the Vanish pool. Every mint below was read from mainnet (owner program,
// decimals, Token-2022 extensions) on 2026-10-07; xStocks mints match the official Backed API.
//
// Deposit sizes are in whole UI units of the *raw* amount. Stock tokens apply dividends and
// splits through a scaled-UI multiplier, so a wallet may show 1 share as e.g. 1.0017.

export const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
export const NATIVE_SOL = "11111111111111111111111111111111"; // Pubkey::default()

const STOCK_SIZES = ["0.1", "1", "10", "50"];
const DOLLAR_SIZES = ["10", "100", "500", "1000"];

export const ASSETS = [
  { symbol: "SOL", name: "Solana", kind: "native", issuer: "Native", mint: NATIVE_SOL, decimals: 9, tokenProgram: null, denominations: ["0.1", "1", "5", "20"] },

  { symbol: "USDC", name: "USD Coin", kind: "dollar", issuer: "Circle", mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", decimals: 6, tokenProgram: TOKEN_PROGRAM, denominations: DOLLAR_SIZES },
  { symbol: "USDT", name: "Tether USD", kind: "dollar", issuer: "Tether", mint: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", decimals: 6, tokenProgram: TOKEN_PROGRAM, denominations: DOLLAR_SIZES },
  { symbol: "USDG", name: "Global Dollar", kind: "dollar", issuer: "Paxos", mint: "2u1tszSeqZ3qBWF3uNGPFc8TzMk2tdiwknnRMWGWjGWH", decimals: 6, tokenProgram: TOKEN_2022_PROGRAM, denominations: DOLLAR_SIZES },

  { symbol: "NVDAx", underlying: "NVDA", name: "NVIDIA", kind: "stock", issuer: "xStocks", mint: "Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh", decimals: 8, tokenProgram: TOKEN_2022_PROGRAM, denominations: STOCK_SIZES },
  { symbol: "TSLAx", underlying: "TSLA", name: "Tesla", kind: "stock", issuer: "xStocks", mint: "XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB", decimals: 8, tokenProgram: TOKEN_2022_PROGRAM, denominations: STOCK_SIZES },
  { symbol: "AAPLx", underlying: "AAPL", name: "Apple", kind: "stock", issuer: "xStocks", mint: "XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp", decimals: 8, tokenProgram: TOKEN_2022_PROGRAM, denominations: STOCK_SIZES },
  { symbol: "SPYx", underlying: "SPY", name: "S&P 500", kind: "stock", issuer: "xStocks", mint: "XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W", decimals: 8, tokenProgram: TOKEN_2022_PROGRAM, denominations: STOCK_SIZES },
  { symbol: "QQQx", underlying: "QQQ", name: "Nasdaq 100", kind: "stock", issuer: "xStocks", mint: "Xs8S1uUs1zvS2p7iwtsG3b6fkhpvmwz4GYU3gWAmWHZ", decimals: 8, tokenProgram: TOKEN_2022_PROGRAM, denominations: STOCK_SIZES },
  { symbol: "MSTRx", underlying: "MSTR", name: "Strategy", kind: "stock", issuer: "xStocks", mint: "XsP7xzNPvEHS1m6qfanPUGjNmdnmsLKEoNAnHjdxxyZ", decimals: 8, tokenProgram: TOKEN_2022_PROGRAM, denominations: STOCK_SIZES },
  { symbol: "COINx", underlying: "COIN", name: "Coinbase", kind: "stock", issuer: "xStocks", mint: "Xs7ZdzSHLU9ftNJsii5fCeJhoRWSC32SQGzGQtePxNu", decimals: 8, tokenProgram: TOKEN_2022_PROGRAM, denominations: STOCK_SIZES },
  { symbol: "HOODx", underlying: "HOOD", name: "Robinhood", kind: "stock", issuer: "xStocks", mint: "XsvNBAYkrDRNhA7wPHQfX3ZUXZyZLdnCQDfHZ56bzpg", decimals: 8, tokenProgram: TOKEN_2022_PROGRAM, denominations: STOCK_SIZES },
  { symbol: "SPCX", underlying: "SPCX", name: "SpaceX", kind: "stock", issuer: "Backpack · Sunrise", mint: "SPCXxcqXj6e5dJDVNovHN8744zkbhM2bYudU45BimGb", decimals: 6, tokenProgram: TOKEN_2022_PROGRAM, denominations: STOCK_SIZES },
  { symbol: "MSTR", underlying: "MSTR", name: "Strategy", kind: "stock", issuer: "Backpack · Sunrise", mint: "MSTRdWXMeZxdE8osAQy3fA4rvTY5rgummDSMEx6U7Nz", decimals: 6, tokenProgram: TOKEN_2022_PROGRAM, denominations: STOCK_SIZES },
];

export const assetBySymbol = (s) => {
  const a = ASSETS.find((x) => x.symbol.toLowerCase() === String(s).toLowerCase());
  if (!a) throw new Error(`unknown asset ${s}; listed: ${ASSETS.map((x) => x.symbol).join(", ")}`);
  return a;
};
export const assetByMint = (m) => ASSETS.find((x) => x.mint === String(m));
