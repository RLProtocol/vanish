// Vanish relayer core: submits withdrawals, private swaps and private buys as fee payer so users'
// wallets never appear on-chain. Fees, recipients and swap/buy terms are sealed inside the proofs.
// Used by the local server (cli/relayer.mjs) and the Vercel functions (api/*.mjs) through handle().
//
// Env: RELAYER_SECRET (keypair as a JSON byte array or base58) or RELAYER_KEYPAIR (path to a keypair file),
//      RPC_URL, FEE_BPS, ALLOW_FREE_MERGES, MIN_FEES, JUP_API_KEY, JUP_API, JUP_DEXES, BROADCAST_RPCS
import fs from "fs";
import bs58 from "bs58";
import { Connection, Keypair as SolKeypair, PublicKey, ComputeBudgetProgram, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { NATIVE_MINT, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction } from "@solana/spl-token";
import { MIN_GAS, buyCancelInstruction, buyExecuteInstruction, buyOpenInstruction, buyOrderPda, decodeBuyOrder, destinationTokenAccount, orderTokenAccount } from "../sdk/buy.js";
import {
  JUPITER_PROGRAM_ID, decodeOrder, escrowAddress, orderPda, swapCancelInstruction, swapCommitOutInstruction,
  swapExecuteInstruction, swapOpenInstruction, swapPrepareInstruction,
} from "../sdk/swap.js";
import { ASSETS, NATIVE_SOL, assetByMint } from "../sdk/assets.js";
import { SolMixClient, toRaw, transactInstruction } from "../sdk/solmix.js";
import { Keypair } from "../sdk/crypto.js";
const deployment = JSON.parse(fs.readFileSync(new URL("../deployments/mainnet.json", import.meta.url), "utf8"));
export const PROGRAM_ID = new PublicKey(process.env.PROGRAM_ID ?? deployment.programId);
const connection = new Connection(process.env.RPC_URL ?? "https://solana-rpc.publicnode.com", "confirmed");

function loadRelayerKey() {
  const secret = process.env.RELAYER_SECRET?.trim();
  if (secret) return SolKeypair.fromSecretKey(secret.startsWith("[") ? Uint8Array.from(JSON.parse(secret)) : bs58.decode(secret));
  return SolKeypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(process.env.RELAYER_KEYPAIR ?? "keys/relayer.json", "utf8"))));
}
const relayer = loadRelayerKey();
export const relayerAddress = relayer.publicKey;
const FEE_BPS = BigInt(process.env.FEE_BPS ?? 30);
// Merges move no value out, so they can't pay a percentage fee; allow them at the relayer's cost.
const ALLOW_FREE_MERGES = process.env.ALLOW_FREE_MERGES === "true";
// Every withdrawal costs the relayer ~0.002 SOL of nullifier rent (+ ~0.002 if it creates the
// recipient's token account), so the fee is max(FEE_BPS of the amount, a per-asset minimum).
// Override with MIN_FEES='{"SOL":"0.003","USDC":"0.5","NVDAx":"0.002"}'.
const MIN_FEE_BY_KIND = { native: "0.003", dollar: "0.5", stock: "0.002" };
const minFeeOverrides = JSON.parse(process.env.MIN_FEES ?? "{}");
const MIN_FEES = Object.fromEntries(
  ASSETS.map((a) => [a.mint, toRaw(minFeeOverrides[a.symbol] ?? MIN_FEE_BY_KIND[a.kind], a.decimals)]),
);
// A private buy costs the relayer more (nullifiers, the buyer's token account, two transactions).
const BUY_MIN_FEES = Object.fromEntries(Object.entries(MIN_FEES).map(([m, v]) => [m, v * 2n]));
// A private swap: three proofs, six nullifiers, four transactions.
const SWAP_MIN_FEES = Object.fromEntries(Object.entries(MIN_FEES).map(([m, v]) => [m, v * 3n]));
// Jupiter: the free lite API by default, the keyed API when JUP_API_KEY is set.
const JUP_KEY = process.env.JUP_API_KEY ?? "";
// Tried in order; a 429/5xx or network error moves on to the next one (with backoff between rounds).
const JUP_BASES = (process.env.JUP_API ?? (JUP_KEY ? "https://api.jup.ag" : "https://lite-api.jup.ag,https://api.jup.ag")).split(",").map((u) => u.trim()).filter(Boolean);
const helper = new SolMixClient({ connection, programId: PROGRAM_ID, keypair: new Keypair(1n), prove: null });
const lut = deployment.lookupTable ? (await connection.getAddressLookupTable(new PublicKey(deployment.lookupTable))).value : null;

function parseArgs(a) {
  return {
    proof: Uint8Array.from(a.proof),
    root: BigInt(a.root),
    inputNullifiers: a.inputNullifiers.map(BigInt),
    outputCommitments: a.outputCommitments.map(BigInt),
    extAmount: BigInt(a.extAmount),
    fee: BigInt(a.fee),
    enc1: Uint8Array.from(a.enc1),
    enc2: Uint8Array.from(a.enc2),
  };
}

async function relay(body) {
  const asset = assetByMint(body.mint);
  if (!asset) throw new Error("asset is not listed");
  const args = parseArgs(body.args);
  if (args.extAmount > 0n) throw new Error("relayer does not submit deposits");
  if (args.extAmount === 0n && args.fee === 0n && !ALLOW_FREE_MERGES) throw new Error("merges need a fee on this relayer");
  const pct = args.extAmount < 0n ? (-args.extAmount * FEE_BPS + 9999n) / 10000n : 0n;
  const minFee = args.extAmount < 0n ? (pct > MIN_FEES[asset.mint] ? pct : MIN_FEES[asset.mint]) : 0n;
  if (args.fee < minFee) throw new Error(`fee too low, need at least ${minFee}`);

  const feeAccount = helper.receivingAccount(asset, relayer.publicKey);
  const recipient = new PublicKey(body.recipient);
  const ixs = [ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 100_000 })];
  if (asset.mint !== NATIVE_SOL) {
    const mint = new PublicKey(asset.mint);
    const tp = new PublicKey(asset.tokenProgram);
    ixs.push(createAssociatedTokenAccountIdempotentInstruction(relayer.publicKey, feeAccount, relayer.publicKey, mint, tp));
    if (body.recipientOwner) {
      const owner = new PublicKey(body.recipientOwner);
      if (!helper.receivingAccount(asset, owner).equals(recipient)) throw new Error("recipient is not the owner's token account");
      ixs.push(createAssociatedTokenAccountIdempotentInstruction(relayer.publicKey, recipient, owner, mint, tp));
    }
  }
  ixs.push(transactInstruction({ programId: PROGRAM_ID, signer: relayer.publicKey, asset, recipient, relayer: feeAccount, args }));

  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  const tx = new VersionedTransaction(
    new TransactionMessage({ payerKey: relayer.publicKey, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message(lut ? [lut] : []),
  );
  tx.sign([relayer]);
  const sim = await connection.simulateTransaction(tx, { commitment: "confirmed" });
  if (sim.value.err) throw new Error(`simulation failed: ${JSON.stringify(sim.value.err)} ${(sim.value.logs ?? []).slice(-3).join(" | ")}`);
  const signature = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: true, maxRetries: 5 });
  return { signature, blockhash, lastValidBlockHeight };
}

// ---------------------------------------------------------------------------- private buy

const jupMint = (m) => (m === NATIVE_SOL ? NATIVE_MINT.toBase58() : m);
/** Jupiter API call with retries: transient failures (429, 5xx, network) fall over to the next base and back off. */
async function jup(path, init = {}) {
  let last;
  for (let round = 0; round < 3; round++) {
    for (const base of JUP_BASES) {
      try {
        const res = await fetch(base + path, {
          ...init,
          signal: AbortSignal.timeout(10_000),
          headers: { "content-type": "application/json", ...(JUP_KEY ? { "x-api-key": JUP_KEY } : {}), ...init.headers },
        });
        const json = await res.json().catch(() => ({}));
        if (res.ok && !json.error) return json;
        last = new Error(`Jupiter: ${json.error ?? json.message ?? res.status}`);
        // a real answer (no route, bad mint...) won't change on retry
        if (res.status < 500 && res.status !== 429) throw Object.assign(last, { final: true });
      } catch (e) {
        if (e.final) throw e;
        last = e.name === "TimeoutError" ? new Error("Jupiter: timed out") : last ?? e;
      }
    }
    await new Promise((r) => setTimeout(r, 400 * 2 ** round));
  }
  throw new Error(`${last?.message ?? "Jupiter unavailable"} (price service busy, try again in a moment)`);
}

// Routes run inside Vanish (a CPI), so they may only use permissionless AMMs. Many "prop" market makers
// (HumidiFi, SolFi, GoonFi, BisonFi, ...) reject any call that isn't a top-level Jupiter instruction.
// Override with JUP_DEXES="Raydium,Whirlpool,...".
const CPI_SAFE_DEXES = process.env.JUP_DEXES ?? [
  "Raydium", "Raydium CLMM", "Raydium CP", "Raydium Launchlab", "Whirlpool", "Orca V1", "Orca V2", "Meteora", "Meteora DLMM", "Meteora DAMM v2",
  "Dynamic Bonding Curve", "Pump.fun", "Pump.fun Amm", "Phoenix", "OpenBook V2", "Manifest", "Invariant", "Saber", "Saber (Decimals)",
  "Stabble Stable Swap", "Stabble Weighted Swap", "Stabble CLMM", "Byreal", "PancakeSwap", "Crema", "Saros", "Saros DLMM", "FluxBeam",
  "Boop.fun", "Heaven", "Moonit", "Bonkswap", "GooseFX GAMMA", "DefiTuna", "Sanctum Infinity", "Token Swap",
].join(",");

// Identical quote requests within a few seconds share one Jupiter call (the UI polls; many users ask the same thing).
const quoteCache = new Map();
function jupQuote({ inputMint, outputMint, amount, slippageBps = 100, fresh = false, direct = false }) {
  const q = new URLSearchParams({
    inputMint: jupMint(inputMint), outputMint: jupMint(outputMint), amount: String(amount), slippageBps: String(slippageBps), swapMode: "ExactIn",
    // our own accounts + the route must fit one transaction
    maxAccounts: "30", restrictIntermediateTokens: "true", dexes: CPI_SAFE_DEXES,
    ...(direct ? { onlyDirectRoutes: "true" } : {}),
  });
  const key = q.toString();
  const hit = quoteCache.get(key);
  if (!fresh && hit && Date.now() - hit.at < 4000) return hit.promise;
  const promise = jup(`/swap/v1/quote?${q}`);
  quoteCache.set(key, { at: Date.now(), promise });
  promise.catch(() => quoteCache.delete(key));
  if (quoteCache.size > 500) quoteCache.delete(quoteCache.keys().next().value);
  return promise;
}

/** Decimals, token program and display info for any mint. */
async function tokenInfo(mint) {
  const key = new PublicKey(mint);
  const acc = await connection.getAccountInfo(key, "confirmed");
  if (!acc) throw new Error("no such token");
  if (!acc.owner.equals(TOKEN_PROGRAM_ID) && !acc.owner.equals(TOKEN_2022_PROGRAM_ID)) throw new Error("not a token mint");
  const decimals = acc.data[44];
  // display data only: Jupiter's token list and DexScreener's deepest pair, either may be missing
  const [meta, pair] = await Promise.all([
    jup(`/tokens/v2/search?query=${key.toBase58()}`)
      .then((found) => (Array.isArray(found) ? found : []).find((t) => t.id === key.toBase58()) ?? {})
      .catch(() => ({})),
    fetch(`https://api.dexscreener.com/tokens/v1/solana/${key.toBase58()}`)
      .then((r) => (r.ok ? r.json() : []))
      .then((pairs) => (Array.isArray(pairs) ? pairs : []).sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0] ?? null)
      .catch(() => null),
  ]);
  const base = pair?.baseToken?.address === key.toBase58() ? pair.baseToken : null;
  return {
    mint: key.toBase58(), decimals, tokenProgram: acc.owner.toBase58(),
    symbol: (meta.symbol ?? base?.symbol)?.trim() || null,
    name: (meta.name ?? base?.name)?.trim() || null,
    icon: pair?.info?.imageUrl ?? meta.icon ?? null,
    banner: pair?.info?.header ?? null,
    usdPrice: pair?.priceUsd ? Number(pair.priceUsd) : (meta.usdPrice ?? null),
    marketCap: pair?.marketCap ?? pair?.fdv ?? meta.mcap ?? null,
    liquidityUsd: pair?.liquidity?.usd ?? meta.liquidity ?? null,
    change24h: pair?.priceChange?.h24 ?? null,
    dexscreener: pair?.url ?? null,
    pairCreatedAt: pair?.pairCreatedAt ?? null,
    verified: !!meta.isVerified, launchpad: meta.launchpad ?? null,
  };
}

async function quote(params) {
  const assetIn = assetByMint(params.get("mintIn"));
  if (!assetIn) throw new Error("input asset is not listed");
  const q = await jupQuote({
    inputMint: assetIn.mint, outputMint: params.get("mintOut") === NATIVE_SOL ? NATIVE_SOL : new PublicKey(params.get("mintOut")).toBase58(), amount: BigInt(params.get("amount")),
    slippageBps: Number(params.get("slippageBps") ?? 100),
  });
  return { inAmount: q.inAmount, outAmount: q.outAmount, minOut: q.otherAmountThreshold, priceImpactPct: q.priceImpactPct, route: (q.routePlan ?? []).map((r) => r.swapInfo?.label).filter(Boolean) };
}

// Extra endpoints that also receive every broadcast, so a transaction reaches the leader even when
// one RPC forwards slowly. Override with BROADCAST_RPCS="https://a,https://b".
const BROADCAST = (process.env.BROADCAST_RPCS ?? "https://api.mainnet-beta.solana.com")
  .split(",").map((u) => u.trim()).filter((u) => u && u !== connection.rpcEndpoint)
  .map((u) => new Connection(u, "confirmed"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const bs58encode = (b) => bs58.encode(b);
const broadcast = (raw) => {
  for (const c of [connection, ...BROADCAST]) c.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 0 }).catch(() => {});
};
async function statusOf(signature) {
  for (const c of [connection, ...BROADCAST]) {
    try {
      const st = (await c.getSignatureStatuses([signature], { searchTransactionHistory: true })).value[0];
      if (st) return st;
    } catch {
      /* try the next endpoint */
    }
  }
  return null;
}

/**
 * Simulates, signs, broadcasts and waits for `confirmed`. A transaction that was seen at all is
 * waited out, never reported as expired, and before giving up on one that wasn't, the chain is
 * re-checked for ~20 s: a transaction can land in the last valid blocks.
 */
async function sendAndConfirm(ixs, luts = []) {
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  const tx = new VersionedTransaction(new TransactionMessage({ payerKey: relayer.publicKey, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message(luts.filter(Boolean)));
  tx.sign([relayer]);
  const raw = tx.serialize();
  const sim = await connection.simulateTransaction(tx, { commitment: "confirmed" });
  if (sim.value.err) {
    const logs = (sim.value.logs ?? []).filter((l) => !/consumed|invoke \[|success$/.test(l)).slice(-25);
    console.log(`simulation failed ${JSON.stringify(sim.value.err)}; program logs:\n  ${logs.join("\n  ")}`);
    throw new Error(`simulation failed: ${JSON.stringify(sim.value.err)} ${(sim.value.logs ?? []).slice(-3).join(" | ")}`);
  }
  const signature = bs58encode(tx.signatures[0]);
  broadcast(raw);
  let seen = false;
  for (let tick = 0; ; tick++) {
    await sleep(1500);
    const st = await statusOf(signature);
    if (st?.err) throw new Error(`transaction failed: ${JSON.stringify(st.err)}`);
    if (st?.confirmationStatus === "confirmed" || st?.confirmationStatus === "finalized") return signature;
    if (st) seen = true; // processed: it's in a block, just not confirmed yet
    if (!seen && (await connection.getBlockHeight("confirmed").catch(() => 0)) > lastValidBlockHeight) {
      for (let i = 0; i < 10; i++) {
        await sleep(2000);
        const late = await statusOf(signature);
        if (late?.err) throw new Error(`transaction failed: ${JSON.stringify(late.err)}`);
        if (late) { seen = true; break; }
      }
      if (!seen) throw new Error("transaction expired");
    }
    if (seen && tick > 120) throw new Error(`transaction ${signature} stuck unconfirmed`);
    if (!seen && tick % 2 === 1) broadcast(raw);
  }
}

/** Runs `step`; if it fails ambiguously (e.g. expired) but `done()` shows its effect on-chain, carries on. */
async function step(name, run, done) {
  try {
    return await run();
  } catch (e) {
    if (/simulation failed|transaction failed/.test(e.message)) throw e;
    if (await done().catch(() => false)) {
      console.log(`${name}: ${e.message}, but it landed; continuing`);
      return null;
    }
    throw e;
  }
}
const budget = (units) => [ComputeBudgetProgram.setComputeUnitLimit({ units }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 100_000 })];

/**
 * Opens the order (spends the user's notes), then runs a fresh Jupiter route into the
 * destination. If no route fills min_out before the deadline, cancels: the input goes to the
 * destination wallet instead.
 */
async function buy(body) {
  const assetIn = assetByMint(body.mintIn);
  if (!assetIn) throw new Error("input asset is not listed");
  const args = parseArgs(body.args);
  const orderId = Uint8Array.from(body.orderId);
  if (orderId.length !== 32) throw new Error("bad order id");
  const terms = {
    mintOut: new PublicKey(body.terms.mintOut).toBase58(), minOut: BigInt(body.terms.minOut), deadline: BigInt(body.terms.deadline),
    destination: new PublicKey(body.terms.destination).toBase58(), gas: BigInt(body.terms.gas),
  };
  if (args.extAmount >= 0n) throw new Error("a buy spends notes");
  const spend = -args.extAmount;
  if (terms.gas && terms.gas < MIN_GAS) throw new Error("gas below the minimum");
  const amountIn = spend - terms.gas;
  const pct = (spend * FEE_BPS + 9999n) / 10000n;
  const minFee = pct > BUY_MIN_FEES[assetIn.mint] ? pct : BUY_MIN_FEES[assetIn.mint];
  if (args.fee < minFee) throw new Error(`fee too low, need at least ${minFee}`);
  const now = BigInt(Math.floor(Date.now() / 1000));
  if (terms.deadline < now + 30n || terms.deadline > now + 900n) throw new Error("deadline must be 30 s to 15 min away");
  const out = await tokenInfo(terms.mintOut);

  // refuse up front (nothing spent yet) if the market can't currently fill min_out
  const first = await jupQuote({ inputMint: assetIn.mint, outputMint: terms.mintOut, amount: amountIn, slippageBps: 100, fresh: true });
  if (BigInt(first.outAmount) < terms.minOut) throw new Error("price moved: the current quote is below your minimum, nothing was spent");

  const order = buyOrderPda(PROGRAM_ID, orderId);
  const feeAccount = helper.receivingAccount(assetIn, relayer.publicKey);
  const openIxs = budget(400_000);
  if (assetIn.mint !== NATIVE_SOL) {
    openIxs.push(createAssociatedTokenAccountIdempotentInstruction(relayer.publicKey, feeAccount, relayer.publicKey, new PublicKey(assetIn.mint), new PublicKey(assetIn.tokenProgram)));
  }
  openIxs.push(buyOpenInstruction({ programId: PROGRAM_ID, relayer: relayer.publicKey, relayerFeeAccount: feeAccount, assetIn, orderId, terms, open: args }));
  const openSignature = await step("buy_open", () => sendAndConfirm(openIxs, [lut]), async () => !!(await connection.getAccountInfo(order, "confirmed")));
  console.log(`buy opened ${openSignature ?? "(confirmed on-chain)"}`);

  const destination = new PublicKey(terms.destination);
  const destToken = destinationTokenAccount(destination, terms.mintOut, out.tokenProgram);
  let lastError;
  for (let attempt = 0; attempt < 3 && BigInt(Math.floor(Date.now() / 1000)) < terms.deadline - 5n; attempt++) {
    try {
      const { route, luts: jupLuts, quote: q } = await jupRoute({
        assetIn, outputMint: terms.mintOut, amount: amountIn, user: order, destination: destToken, quote: attempt === 0 ? first : undefined,
      });
      const signature = await sendAndConfirm([
        ...budget(1_400_000),
        createAssociatedTokenAccountIdempotentInstruction(relayer.publicKey, destToken, destination, new PublicKey(terms.mintOut), new PublicKey(out.tokenProgram)),
        // some routes reference the order's own output account; it is swept and closed in the same instruction
        createAssociatedTokenAccountIdempotentInstruction(relayer.publicKey, orderTokenAccount(order, terms.mintOut, out.tokenProgram), order, new PublicKey(terms.mintOut), new PublicKey(out.tokenProgram)),
        buyExecuteInstruction({ programId: PROGRAM_ID, relayer: relayer.publicKey, assetIn, order, destination, mintOut: terms.mintOut, tokenProgramOut: out.tokenProgram, route, withOrderTokenOut: true }),
      ], [lut, ...jupLuts]);
      console.log(`buy filled ${signature}`);
      return { status: "filled", openSignature, signature, expectedOut: q.outAmount };
    } catch (e) {
      lastError = e;
      console.log(`buy attempt ${attempt + 1} failed: ${e.message}`);
    }
  }

  // couldn't fill: the input (and gas) goes to the destination wallet instead
  const info = await connection.getAccountInfo(order, "confirmed");
  if (!info) return { status: "filled", openSignature, signature: null, note: "order already closed" }; // an execute landed after all
  const state = decodeBuyOrder(info.data);
  const cancelIxs = budget(200_000);
  if (assetIn.mint !== NATIVE_SOL) {
    cancelIxs.push(createAssociatedTokenAccountIdempotentInstruction(
      relayer.publicKey, destinationTokenAccount(destination, assetIn.mint, assetIn.tokenProgram), destination, new PublicKey(assetIn.mint), new PublicKey(assetIn.tokenProgram),
    ));
  }
  cancelIxs.push(buyCancelInstruction({ programId: PROGRAM_ID, caller: relayer.publicKey, order, state, assetIn }));
  const signature = await sendAndConfirm(cancelIxs, [lut]);
  console.log(`buy refunded ${signature}`);
  return { status: "refunded", openSignature, signature, reason: lastError?.message };
}

// ---------------------------------------------------------------------------- private swap (listed assets)

/** Builds a Jupiter route for `amount` of assetIn with the order PDA as the user, delivering into `destination`. */
/**
 * Builds the aggregator instruction with the order PDA as the user. The order only owns its two
 * escrows, so the route must not touch any other token account of the user's: multi-hop routes use
 * Jupiter's shared accounts for the intermediate token; if a route can't, fall back to the best
 * single-pool route (which only touches the escrows).
 */
async function jupRoute({ assetIn, outputMint, amount, user, destination, quote }) {
  const build = (q, shared) =>
    jup("/swap/v1/swap-instructions", {
      method: "POST",
      body: JSON.stringify({
        quoteResponse: q, userPublicKey: user.toBase58(), wrapAndUnwrapSol: false, destinationTokenAccount: destination.toBase58(),
        skipUserAccountsRpcCalls: true, useSharedAccounts: shared,
      }),
    });
  let q = quote ?? (await jupQuote({ inputMint: assetIn.mint, outputMint, amount, slippageBps: 100, fresh: true }));
  let built;
  try {
    built = await build(q, true);
  } catch (e) {
    if (q.routePlan?.length === 1) throw e;
    console.log(`shared-accounts route unavailable (${e.message}); using a direct route`);
    q = await jupQuote({ inputMint: assetIn.mint, outputMint, amount, slippageBps: 100, fresh: true, direct: true });
    built = await build(q, q.routePlan?.length === 1 ? false : true);
  }
  const si = built.swapInstruction;
  if (si.programId !== JUPITER_PROGRAM_ID.toBase58()) throw new Error("unexpected swap program");
  const luts = await Promise.all((built.addressLookupTableAddresses ?? []).map(async (a) => (await connection.getAddressLookupTable(new PublicKey(a))).value));
  return {
    quote: q,
    luts,
    route: { programId: new PublicKey(si.programId), keys: si.accounts.map((a) => ({ pubkey: a.pubkey, isWritable: a.isWritable })), data: Uint8Array.from(Buffer.from(si.data, "base64")) },
  };
}

/**
 * Runs the four-step swap: prepare (refund notes), commit_out (output notes), open (spend), then a
 * fresh Jupiter route into the order's output escrow. If it can't fill, cancels: the refund notes
 * are credited, so the user keeps their funds privately (minus the fee).
 */
async function swap(body) {
  const assetIn = assetByMint(body.mintIn);
  const assetOut = assetByMint(body.mintOut);
  if (!assetIn || !assetOut || assetIn === assetOut) throw new Error("swap needs two different listed assets");
  const orderId = Uint8Array.from(body.orderId);
  if (orderId.length !== 32) throw new Error("bad order id");
  const refund = parseArgs(body.refund);
  const out = parseArgs(body.out);
  const open = parseArgs(body.open);
  const deadline = BigInt(body.deadline);
  const amountIn = refund.extAmount;
  if (amountIn <= 0n || open.extAmount !== -amountIn) throw new Error("refund and spend amounts don't match");
  const minOut = out.extAmount;
  if (minOut <= 0n) throw new Error("bad minimum output");
  const pct = (amountIn * FEE_BPS + 9999n) / 10000n;
  const minFee = pct > SWAP_MIN_FEES[assetIn.mint] ? pct : SWAP_MIN_FEES[assetIn.mint];
  if (open.fee < minFee) throw new Error(`fee too low, need at least ${minFee}`);
  const now = BigInt(Math.floor(Date.now() / 1000));
  if (deadline < now + 60n || deadline > now + 900n) throw new Error("deadline must be 1 to 15 min away");

  const first = await jupQuote({ inputMint: assetIn.mint, outputMint: assetOut.mint, amount: amountIn, slippageBps: 100, fresh: true });
  if (BigInt(first.outAmount) < minOut) throw new Error("price moved: the current quote is below your minimum, nothing was spent");

  const order = orderPda(PROGRAM_ID, orderId);
  const feeAccount = helper.receivingAccount(assetIn, relayer.publicKey);
  const R = relayer.publicKey;
  // 1 + 2 spend nothing; if either fails the user has lost nothing
  const orderState = async () => {
    const info = await connection.getAccountInfo(order, "confirmed");
    return info ? decodeOrder(info.data) : null;
  };
  const prepareSignature = await step("swap_prepare",
    () => sendAndConfirm([...budget(400_000), swapPrepareInstruction({ programId: PROGRAM_ID, relayer: R, assetIn, orderId, deadline, refund })], [lut]),
    async () => !!(await orderState()));
  let openSignature = null;
  try {
    await step("swap_commit_out",
      () => sendAndConfirm([...budget(400_000), swapCommitOutInstruction({ programId: PROGRAM_ID, relayer: R, assetOut, order, out })], [lut]),
      async () => (await orderState())?.outReady);
    const openIxs = budget(400_000);
    if (assetIn.mint !== NATIVE_SOL) openIxs.push(createAssociatedTokenAccountIdempotentInstruction(R, feeAccount, R, new PublicKey(assetIn.mint), new PublicKey(assetIn.tokenProgram)));
    openIxs.push(swapOpenInstruction({ programId: PROGRAM_ID, relayer: R, relayerFeeAccount: feeAccount, assetIn, order, open }));
    openSignature = await step("swap_open", () => sendAndConfirm(openIxs, [lut]), async () => (await orderState())?.opened);
    console.log(`swap opened ${openSignature ?? "(confirmed on-chain)"}`);
  } catch (e) {
    // only safe to say "nothing was spent" if the order never opened
    const st = await orderState().catch(() => null);
    await cancelSwap(order, assetIn, assetOut).catch(() => {});
    if (st?.opened) throw new Error(`swap cancelled, your funds were refunded privately: ${e.message}`);
    throw new Error(`swap not started, nothing was spent: ${e.message}`);
  }

  const relayerOut = assetOut.mint === NATIVE_SOL ? R : helper.receivingAccount(assetOut, R);
  let lastError;
  for (let attempt = 0; attempt < 3 && BigInt(Math.floor(Date.now() / 1000)) < deadline - 5n; attempt++) {
    try {
      const { route, luts, quote: q } = await jupRoute({ assetIn, outputMint: assetOut.mint, amount: amountIn, user: order, destination: escrowAddress(order, assetOut) });
      const ixs = budget(1_400_000);
      if (assetOut.mint !== NATIVE_SOL) ixs.push(createAssociatedTokenAccountIdempotentInstruction(R, relayerOut, R, new PublicKey(assetOut.mint), new PublicKey(assetOut.tokenProgram)));
      ixs.push(swapExecuteInstruction({ programId: PROGRAM_ID, relayer: R, assetIn, assetOut, order, relayerOutAccount: relayerOut, route }));
      const signature = await sendAndConfirm(ixs, [lut, ...luts]);
      console.log(`swap filled ${signature}`);
      return { status: "filled", openSignature, signature, expectedOut: q.outAmount };
    } catch (e) {
      lastError = e;
      console.log(`swap attempt ${attempt + 1} failed: ${e.message}`);
    }
  }
  const signature = await cancelSwap(order, assetIn, assetOut);
  console.log(`swap refunded ${signature}`);
  return { status: "refunded", openSignature, signature, reason: lastError?.message, prepareSignature };
}

async function cancelSwap(order, assetIn, assetOut) {
  const info = await connection.getAccountInfo(order, "confirmed");
  if (!info) return null;
  const state = decodeOrder(info.data);
  return sendAndConfirm([...budget(300_000), swapCancelInstruction({ programId: PROGRAM_ID, caller: relayer.publicKey, order, state, assetIn, assetOut })], [lut]);
}

// ---------------------------------------------------------------------------- entry point

function info() {
  const str = (o) => Object.fromEntries(Object.entries(o).map(([m, v]) => [m, v.toString()]));
  return {
    address: relayer.publicKey.toBase58(),
    programId: PROGRAM_ID.toBase58(),
    feeBps: Number(FEE_BPS),
    minFees: str(MIN_FEES),
    allowFreeMerges: ALLOW_FREE_MERGES,
    buy: { minFees: str(BUY_MIN_FEES), minGas: MIN_GAS.toString() },
    swap: { minFees: str(SWAP_MIN_FEES) },
  };
}

/**
 * One relayer request. route: info | token | quote | relay | swap | buy.
 * query: plain object of query params; body: parsed JSON (or a JSON string). Resolves to [status, json].
 */
export async function handle(route, { method = "GET", query = {}, body } = {}) {
  try {
    const params = new URLSearchParams(Object.entries(query).map(([k, v]) => [k, Array.isArray(v) ? v[0] : String(v)]));
    const payload = typeof body === "string" ? JSON.parse(body || "{}") : body;
    if (method === "GET" && route === "info") return [200, info()];
    if (method === "GET" && route === "token") return [200, await tokenInfo(params.get("mint"))];
    if (method === "GET" && route === "quote") return [200, await quote(params)];
    if (method === "POST" && route === "relay") {
      const sent = await relay(payload);
      console.log(`relayed ${sent.signature}`);
      return [200, sent];
    }
    if (method === "POST" && route === "swap") return [200, await swap(payload)];
    if (method === "POST" && route === "buy") return [200, await buy(payload)];
    return [404, { error: "not found" }];
  } catch (e) {
    return [400, { error: e.message }];
  }
}
