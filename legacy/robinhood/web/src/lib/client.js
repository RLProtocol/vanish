// Browser port of src/lib/client.js: reads via public RPC, writes via the connected wallet,
// caches the tree + discovered notes in localStorage.
import { Contract, JsonRpcProvider, ZeroAddress, keccak256, toUtf8Bytes } from "ethers";
import { Keypair, Utxo, toHex32, FIELD_SIZE } from "./crypto.js";
import { MerkleTree } from "./merkleTree.js";
import { prepareTransaction } from "./transaction.js";
import deployment from "../generated/deployment.json";

export const RPC_URL = "https://rpc.mainnet.chain.robinhood.com";
export const EXPLORER = "https://robin.etherscan.io";
export const { chainId: CHAIN_ID, pool: POOL, assets: ASSETS, deployBlock: DEPLOY_BLOCK } = deployment;
export { deployment };

export const POOL_ABI = [
  "function transact((bytes proof,bytes32 root,bytes32[2] inputNullifiers,bytes32[2] outputCommitments,uint256 publicAmount,bytes32 extDataHash) args,(address recipient,int256 extAmount,address relayer,uint256 fee,address token,bytes encryptedOutput1,bytes encryptedOutput2) extData) payable",
  "function levels() view returns (uint32)",
  "function nextIndex() view returns (uint32)",
  "function getLastRoot() view returns (bytes32)",
  "function isSpent(bytes32) view returns (bool)",
  "function depositsPaused(address) view returns (bool)",
  "event NewCommitment(bytes32 commitment, uint256 index, bytes encryptedOutput)",
];
const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
];

export const readProvider = new JsonRpcProvider(RPC_URL, CHAIN_ID, { staticNetwork: true, batchMaxCount: 20 });
const readPool = new Contract(POOL, POOL_ABI, readProvider);

// ---------------------------------------------------------------- key derivation

export const KEY_MESSAGE = [
  "RobinMix private key",
  "",
  "Sign to unlock your private balance on Robinhood Chain.",
  "This signature never leaves your browser and costs no gas.",
  "",
  `Pool: ${POOL}`,
  `Chain: ${CHAIN_ID}`,
].join("\n");

/** Same wallet + same message => same shielded key on any device. */
export function keypairFromSignature(signature) {
  const k = BigInt(keccak256(toUtf8Bytes("robinmix-shielded-key:" + signature))) % FIELD_SIZE;
  return new Keypair(k === 0n ? 1n : k);
}

// ---------------------------------------------------------------- public stats

export async function getPoolStats() {
  const [nextIndex, balances] = await Promise.all([
    readPool.nextIndex(),
    Promise.all(
      ASSETS.map((a) =>
        a.address === ZeroAddress
          ? readProvider.getBalance(POOL)
          : new Contract(a.address, ERC20_ABI, readProvider).balanceOf(POOL),
      ),
    ),
  ]);
  return {
    transactions: Number(nextIndex) / 2,
    notes: Number(nextIndex),
    balances: Object.fromEntries(ASSETS.map((a, i) => [a.symbol, balances[i]])),
  };
}

export async function getWalletBalance(asset, owner) {
  return asset.address === ZeroAddress
    ? readProvider.getBalance(owner)
    : new Contract(asset.address, ERC20_ABI, readProvider).balanceOf(owner);
}

// ---------------------------------------------------------------- client

const toJson = (o) => JSON.stringify(o, (_, v) => (typeof v === "bigint" ? v.toString() : v));

export class RobinMixClient {
  constructor(keypair) {
    this.keypair = keypair;
    this.cacheKey = `robinmix:v1:${POOL.toLowerCase()}:${toHex32(keypair.pubkey).slice(0, 18)}`;
    this.lastBlock = DEPLOY_BLOCK - 1;
    this.notes = [];
    this.tree = null;
    this._syncing = null;
  }

  _load() {
    let leaves = [];
    try {
      const c = JSON.parse(localStorage.getItem(this.cacheKey) || "null");
      if (c) {
        this.lastBlock = c.lastBlock;
        leaves = c.leaves.map(BigInt);
        this.notes = c.notes.map((n) => ({ index: n.index, amount: BigInt(n.amount), blinding: BigInt(n.blinding), assetId: BigInt(n.assetId) }));
      }
    } catch {
      /* corrupt or blocked storage: rescan */
    }
    this.tree = new MerkleTree(20, leaves);
  }

  _save() {
    try {
      localStorage.setItem(this.cacheKey, toJson({ lastBlock: this.lastBlock, leaves: this.tree.leaves.map(toHex32), notes: this.notes }));
    } catch {
      /* storage full or blocked: works without cache */
    }
  }

  resetCache() {
    try {
      localStorage.removeItem(this.cacheKey);
    } catch {}
    this.tree = null;
    this.notes = [];
    this.lastBlock = DEPLOY_BLOCK - 1;
  }

  sync(minBlock = 0) {
    // one sync at a time; callers share the in-flight one
    this._syncing ??= this._sync(minBlock).finally(() => (this._syncing = null));
    return this._syncing;
  }

  async _sync(minBlock) {
    if (!this.tree) this._load();
    const latest = Math.max(Number(await readProvider.send("eth_blockNumber", [])), minBlock, this.lastBlock);
    const filter = readPool.filters.NewCommitment();
    let from = this.lastBlock + 1;
    let chunk = 50000;
    const events = [];
    while (from <= latest) {
      const to = Math.min(from + chunk - 1, latest);
      try {
        events.push(...(await readPool.queryFilter(filter, from, to)));
        from = to + 1;
      } catch (e) {
        if (chunk <= 500) throw e;
        chunk = Math.floor(chunk / 4);
      }
    }
    events.sort((a, b) => Number(a.args.index) - Number(b.args.index));

    const newLeaves = [];
    for (const ev of events) {
      const index = Number(ev.args.index);
      const expected = this.tree.leaves.length + newLeaves.length;
      if (index < expected) continue;
      if (index !== expected) throw new Error("Pool history has a gap. Reset the local cache and try again.");
      const commitment = BigInt(ev.args.commitment);
      newLeaves.push(commitment);
      const dec = await this.keypair.decrypt(ev.args.encryptedOutput);
      if (dec && dec.amount > 0n) {
        const u = new Utxo({ ...dec, keypair: this.keypair, index });
        if (u.getCommitment() === commitment) this.notes.push({ index, ...dec });
      }
    }
    if (newLeaves.length) this.tree.bulkInsert(newLeaves);

    const root = BigInt(await readPool.getLastRoot({ blockTag: latest }));
    if (root !== this.tree.root) throw new Error("Your local copy of the pool is out of date. Reset the local cache and try again.");
    this.lastBlock = latest;
    this._save();
  }

  _utxo(n) {
    return new Utxo({ amount: n.amount, blinding: n.blinding, assetId: n.assetId, keypair: this.keypair, index: n.index });
  }

  /** All our notes with spent flags (for the activity list). */
  async getNotes() {
    await this.sync();
    const utxos = this.notes.map((n) => this._utxo(n));
    const spent = await Promise.all(utxos.map((u) => readPool.isSpent(toHex32(u.getNullifier()))));
    return utxos.map((u, i) => ({ utxo: u, spent: spent[i] }));
  }

  async getUnspent(token) {
    const all = await this.getNotes();
    const id = BigInt(token);
    return all
      .filter((n) => !n.spent && n.utxo.assetId === id)
      .map((n) => n.utxo)
      .sort((a, b) => (b.amount > a.amount ? 1 : b.amount < a.amount ? -1 : 0));
  }

  /** {symbol: {total, notes}} */
  async getBalances() {
    const all = await this.getNotes();
    const out = {};
    for (const a of ASSETS) {
      const mine = all.filter((n) => !n.spent && n.utxo.assetId === BigInt(a.address));
      out[a.symbol] = { total: mine.reduce((s, n) => s + n.utxo.amount, 0n), notes: mine.length };
    }
    return out;
  }

  async _submit({ args, extData }, { signer, relayerUrl, value = 0n, onStage }) {
    if (relayerUrl) {
      onStage?.("relay");
      const res = await fetch(new URL("/relay", relayerUrl), { method: "POST", headers: { "content-type": "application/json" }, body: toJson({ args, extData }) });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(`Relayer refused: ${body.error ?? res.status}`);
      onStage?.("pending", body.txHash);
      const r = await readProvider.waitForTransaction(body.txHash);
      if (r.status !== 1) throw new Error("The relayed transaction reverted.");
      return r;
    }
    onStage?.("confirm");
    const pool = new Contract(POOL, POOL_ABI, signer);
    const tx = await pool.transact(args, extData, { value });
    onStage?.("pending", tx.hash);
    const r = await tx.wait();
    if (r.status !== 1) throw new Error("The transaction reverted.");
    return r;
  }

  async shield({ asset, amount, signer, onStage, onProgress }) {
    amount = BigInt(amount);
    onStage?.("sync");
    await this.sync();
    if (await readPool.depositsPaused(asset.address)) throw new Error(`Shielding ${asset.symbol} is paused.`);
    if (asset.address !== ZeroAddress) {
      const token = new Contract(asset.address, ERC20_ABI, signer);
      const owner = await signer.getAddress();
      if ((await token.allowance(owner, POOL)) < amount) {
        onStage?.("approve");
        await (await token.approve(POOL, amount)).wait();
      }
    }
    onStage?.("prove");
    const out = new Utxo({ amount, assetId: BigInt(asset.address), keypair: this.keypair });
    const tx = await prepareTransaction({ tree: this.tree, token: asset.address, outputs: [out], extAmount: amount, keypair: this.keypair, onProgress });
    const r = await this._submit(tx, { signer, value: asset.address === ZeroAddress ? amount : 0n, onStage });
    await this.sync(r.blockNumber);
    onStage?.("done", r.hash);
    return r;
  }

  /** Plan how a withdrawal will spend notes (for the review screen). */
  async plan({ asset, amount, fee = 0n }) {
    const utxos = await this.getUnspent(asset.address);
    const need = BigInt(amount) + BigInt(fee);
    const total = utxos.reduce((s, u) => s + u.amount, 0n);
    if (total < need) return { ok: false, total, need };
    const single = [...utxos].reverse().find((u) => u.amount >= need);
    const inputs = single ? [single] : utxos[0].amount + (utxos[1]?.amount ?? 0n) >= need ? utxos.slice(0, 2) : null;
    if (inputs) return { ok: true, total, need, merges: 0, change: inputs.reduce((s, u) => s + u.amount, 0n) - need };
    // count merges needed: each merge combines the two smallest notes
    const amounts = utxos.map((u) => u.amount);
    let merges = 0;
    while (amounts.length > 2 && amounts[0] + amounts[1] < need) {
      amounts.sort((a, b) => (b > a ? 1 : -1));
      const merged = amounts.pop() + amounts.pop();
      amounts.push(merged);
      amounts.sort((a, b) => (b > a ? 1 : -1));
      merges++;
    }
    return { ok: true, total, need, merges, change: total - need };
  }

  async unshield({ asset, amount, recipient, signer, relayerUrl, relayer = ZeroAddress, fee = 0n, onStage, onProgress }) {
    amount = BigInt(amount);
    fee = BigInt(fee);
    const need = amount + fee;
    onStage?.("sync");
    for (;;) {
      const utxos = await this.getUnspent(asset.address);
      const total = utxos.reduce((s, u) => s + u.amount, 0n);
      if (total < need) throw new Error(`Not enough private ${asset.symbol}.`);
      const single = [...utxos].reverse().find((u) => u.amount >= need);
      const inputs = single ? [single] : utxos[0].amount + (utxos[1]?.amount ?? 0n) >= need ? utxos.slice(0, 2) : null;

      if (inputs) {
        onStage?.("prove");
        const change = new Utxo({ amount: inputs.reduce((s, u) => s + u.amount, 0n) - need, assetId: BigInt(asset.address), keypair: this.keypair });
        const tx = await prepareTransaction({
          tree: this.tree, token: asset.address, inputs, outputs: [change], extAmount: -amount, fee, recipient, relayer, keypair: this.keypair, onProgress,
        });
        const r = await this._submit(tx, { signer, relayerUrl, onStage });
        await this.sync(r.blockNumber);
        onStage?.("done", r.hash);
        return r;
      }

      onStage?.("merge");
      const pair = utxos.slice(-2);
      const merged = new Utxo({ amount: pair[0].amount + pair[1].amount, assetId: BigInt(asset.address), keypair: this.keypair });
      const tx = await prepareTransaction({ tree: this.tree, token: asset.address, inputs: pair, outputs: [merged], relayer, keypair: this.keypair, onProgress });
      const r = await this._submit(tx, { signer, relayerUrl, onStage });
      await this.sync(r.blockNumber);
    }
  }
}
